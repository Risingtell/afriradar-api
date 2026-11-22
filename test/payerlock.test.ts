// One mainnet send at a time per paying account: a buyer cannot make several of its own payments
// fail on chain at our cost (each passing simulation while the others were unsent), and an honest
// buyer is never held up for longer than a transaction of theirs could still land.
import { beforeAll, describe, expect, it } from "vitest";
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, SolanaError,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type Address, type Blockhash,
} from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { InMemoryPaymentChannelStorage, UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { createApp } from "../src/app.js";
import { MAINNET, NETWORK, PRODUCTS, USDC_MAINNET } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import { feeGuard, LANDED_GRACE_MS, lockFor, lockOutcome, type Acquired, type LockTarget, type LockWait, type PayerLock } from "../src/netfee.js";
import { PAYER_LOCK_TTL_MS, payerLock, sweepPayerLocks } from "../src/payerlock.js";
import { sendRefusedBy, watchingRefusals } from "../src/sends.js";
import { sqlite } from "../src/sqlite.js";
import { loadedDb } from "./helpers.js";

type Settled = Awaited<ReturnType<FacilitatorClient["settle"]>>;

const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const CHANNELS = address("CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX");
const SYSTEM = address("11111111111111111111111111111111");
const USDC = address(USDC_MAINNET);
const addr = async () => (await generateKeyPairSigner()).address;
const FEE_PAYER = await addr();
const TREASURY_USDC = await addr();

const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
let serial = 1n; // every payment built here is a different transaction
type Ix = Parameters<typeof appendTransactionMessageInstructions>[0][number];

const message = (instructions: Ix[]) =>
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(FEE_PAYER, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
const wire = (instructions: Ix[]) => getBase64EncodedWireTransaction(compileTransaction(message(instructions)));

/** TransferChecked of USDC from `source` to our treasury, signed by `authority` (its owner or a delegate). */
const transfer = (source: Address, authority: Address): Ix => ({
  programAddress: TOKEN,
  accounts: [
    { address: source, role: AccountRole.WRITABLE },
    { address: USDC, role: AccountRole.READONLY },
    { address: TREASURY_USDC, role: AccountRole.WRITABLE },
    { address: authority, role: AccountRole.READONLY_SIGNER },
  ],
  data: Uint8Array.of(12, ...u64(serial++), 6),
});
const dataRequest = async (source: Address, authority: Address) => wire([transfer(source, authority)]);

const FIXED = new Set<Address>([USDC, TOKEN, SYSTEM, CHANNELS]); // programs and the mint: never writable

/** A question's deposit: the payment-channel open (or top-up) paying from `payerToken`. */
async function channelOpen(payer: Address, payerToken: Address, kind: "open" | "top_up" = "open") {
  const x = await Promise.all(Array.from({ length: 14 }, addr));
  const accounts = kind === "open"
    ? [payer, FEE_PAYER, x[2], USDC, x[4], x[5], payerToken, x[7], TOKEN, SYSTEM, x[10], x[11], x[12], CHANNELS]
    : [payer, x[1], payerToken, x[3], USDC, TOKEN];
  return wire([{
    programAddress: CHANNELS,
    accounts: accounts.map((a, i) => ({ address: a, role: i === 0 || (kind === "open" && i === 1) ? AccountRole.WRITABLE_SIGNER : FIXED.has(a) ? AccountRole.READONLY : AccountRole.WRITABLE })),
    data: Uint8Array.of(kind === "open" ? 1 : 3, ...u64(serial++)),
  }]);
}

const exact = (tx: string) => ({ payload: { transaction: tx } }) as unknown as PaymentPayload;
const EXACT = { network: MAINNET, scheme: "exact", amount: "3600" } as unknown as PaymentRequirements;
const deposit = (tx: string, fields: object = { type: "deposit" }) => ({ payload: { openTransaction: tx, maxAmount: "54400", channelId: "c", ...fields } }) as unknown as PaymentPayload;
const upto = (amount = "54400", network = MAINNET) => ({ network, scheme: "upto", amount }) as unknown as PaymentRequirements;

const PENDING: Partial<Settled> = { success: false, errorReason: "settlement_pending", transaction: "sig" };
const SIMULATION_FAILED: Partial<Settled> = { success: false, errorReason: "invalid_exact_svm_payload_transaction_simulation_failed", transaction: "" };

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}
/** Waits up to `maxMs` in 250 ms steps of the fake clock. */
const waitOn = (c: ReturnType<typeof clock>, maxMs = 10_000, onSleep?: (n: number) => void): LockWait => {
  let n = 0;
  return { maxMs, stepMs: 250, sleep: async (ms) => (c.advance(ms), onSleep?.(++n), flush()) };
};
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
/** A facilitator that answers each settle with `script`, and logs when each starts and ends. */
function facilitator(script: (n: number, p: PaymentPayload) => Promise<Partial<Settled>> | Partial<Settled>) {
  const log: string[] = [];
  let n = 0;
  const inner: FacilitatorClient = {
    verify: async () => ({ isValid: true, payer: "x" }),
    settle: async (p, r) => {
      const me = ++n;
      log.push(`start ${me}`);
      const out = await script(me, p);
      log.push(`end ${me}`);
      return { success: true, transaction: `tx${me}`, network: r.network, ...out } as Settled;
    },
    getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
  };
  return { inner, log };
}
/** A guarded facilitator on a fresh lock and fake clock, and one paying account. */
async function setup(script: Parameters<typeof facilitator>[0], maxWaitMs = 0, onSleep?: (n: number) => void) {
  const { inner, log } = facilitator(script);
  const c = clock();
  const lock = payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now);
  const guarded = feeGuard(inner, MAINNET, lock, waitOn(c, maxWaitMs, onSleep));
  const [source, owner] = await Promise.all([addr(), addr()]);
  const pay = async () => exact(await dataRequest(source, owner));
  return { guarded, log, c, lock, source, pay };
}

describe("the payer lock", () => {
  it("belongs to one transaction: the attempt that took it holds it; another attempt of it joins only once it is kept", async () => {
    const c = clock();
    const lock = payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now);
    expect(await lock.acquire("A", "fp1", "h1")).toEqual({ role: "took" });
    // Still being sent: another attempt of the same payment waits like any other payment.
    expect(await lock.acquire("A", "fp1", "h2")).toEqual({ role: "busy", kept: false, same: true, remainingMs: PAYER_LOCK_TTL_MS });
    expect(await lock.acquire("A", "fp2", "h3")).toMatchObject({ role: "busy", kept: false });
    expect(await lock.acquire("B", "fp2", "h3")).toEqual({ role: "took" }); // other accounts are not affected
    await lock.keep("A", "fp1", "h2"); // not the holder: nothing happens
    expect(await lock.acquire("A", "fp1", "h4")).toMatchObject({ role: "busy", kept: false });
    await lock.keep("A", "fp1", "h1"); // its first attempt ended with a send that may still land
    c.advance(30_000);
    expect(await lock.acquire("A", "fp1", "h4")).toEqual({ role: "joined" });
    // Joining wrote nothing: the lock runs out when it always would.
    expect(await lock.acquire("A", "fp2", "h5")).toEqual({ role: "busy", kept: true, same: false, remainingMs: PAYER_LOCK_TTL_MS - 30_000 });
    c.advance(PAYER_LOCK_TTL_MS - 30_000 + 1); // ran out: its blockhash has long expired
    expect(await lock.acquire("A", "fp2", "h5")).toEqual({ role: "took" });
  });

  it("is freed by its holder unless kept, and by any attempt once its transaction is final, never later than before", async () => {
    const c = clock();
    const lock = payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now);
    const role = async (a: Promise<Acquired>) => (await a).role;
    await lock.acquire("A", "fp1", "h1");
    await lock.release("A", "h2"); // anyone but the holder: nothing happens
    expect(await role(lock.acquire("A", "fp9", "h9"))).toBe("busy");
    await lock.release("A", "h1");
    expect(await role(lock.acquire("A", "fp2", "h2"))).toBe("took");

    await lock.keep("A", "fp2", "h2"); // a send of fp2 may still land
    await lock.release("A", "h2");
    expect(await lock.acquire("A", "fp9", "h9")).toEqual({ role: "busy", kept: true, same: false, remainingMs: PAYER_LOCK_TTL_MS });
    await lock.landed("A", "fp9", 0); // another transaction's landing does not touch it
    expect(await role(lock.acquire("A", "fp9", "h9"))).toBe("busy");
    await lock.landed("A", "fp2", 2_000);
    const freeing = await lock.acquire("A", "fp9", "h9");
    expect(freeing.role === "busy" && freeing.remainingMs <= 2_000).toBe(true);
    c.advance(1_000);
    await lock.landed("A", "fp2", 2_000); // later news of the same landing never lengthens it
    c.advance(1_000);
    expect(await role(lock.acquire("A", "fp3", "h3"))).toBe("took");
  });

  it("sweeps locks that ran out over a day ago, and no others", async () => {
    const db = sqlite();
    const c = clock();
    const lock = payerLock(db, PAYER_LOCK_TTL_MS, c.now);
    await lock.acquire("held", "fp1", "h1");
    await lock.acquire("freed", "fp2", "h2");
    await lock.release("freed", "h2");
    expect(await sweepPayerLocks(db, c.now() + 86_400_000)).toBe(1);
    expect((await db.all<{ k: string }>("SELECT k FROM kv WHERE ns = 'payer-lock'")).map((r) => r.k)).toEqual(["held"]);
  });
});

describe("what a mainnet settle locks", () => {
  const target = async (p: PaymentPayload, r: PaymentRequirements) => (await lockFor(p, r)) as LockTarget | null;

  it("a data request locks the account it pays from, so its owner and a delegate wait for each other", async () => {
    const [source, owner, delegate] = await Promise.all([addr(), addr(), addr()]);
    const a = await target(exact(await dataRequest(source, owner)), EXACT);
    const b = await target(exact(await dataRequest(source, delegate)), EXACT);
    expect(a?.account).toBe(source);
    expect(b?.account).toBe(source);
    expect(a?.fp).not.toBe(b?.fp);
  });

  it("the same payment sent again is the same transaction", async () => {
    const tx = await dataRequest(await addr(), await addr());
    expect((await target(exact(tx), EXACT))?.fp).toBe((await target(exact(tx), EXACT))?.fp);
  });

  it("a question's deposit locks the token account its channel open or top-up pays from", async () => {
    const [payer, payerToken] = await Promise.all([addr(), addr()]);
    expect((await target(deposit(await channelOpen(payer, payerToken)), upto()))?.account).toBe(payerToken);
    expect((await target(deposit(await channelOpen(payer, payerToken, "top_up")), upto()))?.account).toBe(payerToken);
    // Without the server's stamp, a deposit is a payload for its whole ceiling with no voucher (as the facilitator reads it).
    expect((await target(deposit(await channelOpen(payer, payerToken), {}), upto()))?.account).toBe(payerToken);
  });

  it("a question's claim and refund lock nothing: we build and send those transactions", async () => {
    const open = await channelOpen(await addr(), await addr());
    expect(await lockFor(deposit(open, { type: "claim", voucherSignature: "v" }), upto("1000"))).toBeNull();
    expect(await lockFor(deposit(open, { type: "claim" }), upto("0"))).toBeNull(); // a refund
    expect(await lockFor(deposit(open, { voucherSignature: "v" }), upto())).toBeNull();
    expect(await lockFor(deposit(open, {}), upto("1000"))).toBeNull();
  });

  it("a payload that is not an object locks nothing, and reaches the facilitator to be refused rather than crashing", async () => {
    expect(await lockFor({ payload: "x" } as unknown as PaymentPayload, upto())).toBeNull();
    const { inner } = facilitator(() => ({}));
    const guarded = feeGuard(inner, MAINNET, payerLock(sqlite()));
    await expect(guarded.verify({ payload: "x" } as unknown as PaymentPayload, upto())).resolves.toMatchObject({ isValid: true });
    await expect(guarded.settle({ payload: 7 } as unknown as PaymentPayload, upto())).resolves.toMatchObject({ success: true });
  });

  it("an unreadable transaction locks nothing: the facilitator refuses it before sending", async () => {
    expect(await lockFor(exact("not a transaction"), EXACT)).toBeNull();
    expect(await lockFor({ payload: {} } as unknown as PaymentPayload, EXACT)).toBeNull();
  });

  it("refuses an account named through a lookup table, so a wallet cannot dodge the lock that way", async () => {
    const [source, owner, table] = await Promise.all([addr(), addr(), addr()]);
    const msg = compressTransactionMessageUsingAddressLookupTables(message([transfer(source, owner)]), { [table]: [source] });
    const viaTable = exact(getBase64EncodedWireTransaction(compileTransaction(msg)));
    expect(await lockFor(viaTable, EXACT)).toEqual({ refuse: expect.stringContaining("address lookup table") });
    const { inner, log } = facilitator(() => ({}));
    const guarded = feeGuard(inner, MAINNET, payerLock(sqlite()));
    expect(await guarded.verify(viaTable, EXACT)).toMatchObject({ isValid: false, invalidReason: "payment_account_in_lookup_table" });
    expect(await guarded.settle(viaTable, EXACT)).toMatchObject({ success: false, errorReason: "payment_account_in_lookup_table" });
    expect(log).toEqual([]);
  });

  it("reads a settle result as final, maybe still landing, or not sent by this attempt", () => {
    const outcome = (r: Partial<Settled>) => lockOutcome({ success: false, transaction: "", network: MAINNET, ...r } as Settled);
    expect(outcome({ success: true, transaction: "sig" })).toEqual({ final: LANDED_GRACE_MS });
    expect(outcome({ errorReason: "settlement_pending", transaction: "sig" })).toBe("maybe");
    // The send threw (signing shares that error but does not fail with a local key): it may have reached the network.
    expect(outcome({ errorReason: "invalid_exact_svm_transaction_failed" })).toBe("maybe");
    expect(outcome({ errorReason: "invalid_upto_svm_channel_broadcast", errorMessage: "fetch failed" })).toBe("maybe");
    // Sent, unconfirmed, and the pending record could not be written.
    expect(outcome({ errorReason: "invalid_exact_svm_transaction_failed", transaction: "sig", errorMessage: "settlement_pending, but failed to persist for retry: D1 down" })).toBe("maybe");
    expect(outcome({ errorReason: "invalid_upto_svm_channel_broadcast", transaction: "sig", errorMessage: "settlement_pending, but failed to persist for retry: D1 down" })).toBe("maybe");
    // Landed and failed: final, and it changed nothing of the buyer's.
    expect(outcome({ errorReason: "invalid_exact_svm_transaction_failed", transaction: "sig", errorMessage: 'Transaction failed onchain: {"InstructionError":[2,{"Custom":1}]}' })).toEqual({ final: 0 });
    expect(outcome({ errorReason: "invalid_upto_svm_channel_broadcast", errorMessage: "Transaction failed onchain: {}" })).toEqual({ final: 0 });
    // Not sent by this attempt.
    expect(outcome({ errorReason: "invalid_upto_svm_channel_already_open" })).toEqual({ final: LANDED_GRACE_MS });
    expect(outcome({ errorReason: "duplicate_settlement" })).toBe("unsent");
    expect(outcome({ errorReason: "invalid_upto_svm_channel_broadcast", errorMessage: "failed to durably record the channel before broadcast: D1 down" })).toBe("unsent");
    expect(outcome({ errorReason: "invalid_exact_svm_payload_transaction_simulation_failed" })).toBe("unsent");
    expect(outcome({ errorReason: "invalid_upto_svm_settlement_simulation" })).toBe("unsent");
    // Landed, then a later check failed.
    expect(outcome({ errorReason: "invalid_upto_svm_channel_state", transaction: "sig" })).toEqual({ final: LANDED_GRACE_MS });
  });
});

describe("mainnet sends from one account", () => {
  it("run one after the other, an owner's and a delegate's alike: the second waits until the first landed", async () => {
    const first = gate();
    const { inner, log } = facilitator(async (n) => (n === 1 ? first.wait.then(() => ({})) : {}));
    const c = clock();
    const guarded = feeGuard(inner, MAINNET, payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now), waitOn(c, 10_000, (n) => n === 3 && first.open()));
    const [source, owner, delegate] = await Promise.all([addr(), addr(), addr()]);
    const a = guarded.settle(exact(await dataRequest(source, owner)), EXACT);
    await flush();
    const b = guarded.settle(exact(await dataRequest(source, delegate)), EXACT);
    const [r1, r2] = await Promise.all([a, b]);
    expect(r1).toMatchObject({ success: true, transaction: "tx1" });
    expect(r2).toMatchObject({ success: true, transaction: "tx2" });
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("waits the grace after a landing before the next is simulated", async () => {
    const { guarded, log, c, pay } = await setup(() => ({}), 10_000);
    await guarded.settle(await pay(), EXACT);
    const started = c.now();
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ success: true });
    expect(c.now() - started).toBeGreaterThanOrEqual(LANDED_GRACE_MS);
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("refuses the next, uncharged, while one may still land, saying when to pay again", async () => {
    const { guarded, log, c, pay } = await setup((n) => (n === 1 ? PENDING : {}), 10_000);
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ errorReason: "settlement_pending" });
    const refused = await guarded.settle(await pay(), EXACT);
    expect(refused).toMatchObject({ success: false, errorReason: "payer_busy" });
    expect(refused.errorMessage).toBe("an earlier payment from this account may still land on chain; nothing was charged for this one, pay again in 80 seconds");
    expect(log).toEqual(["start 1", "end 1"]); // the second never reached the facilitator
    c.advance(PAYER_LOCK_TTL_MS); // its blockhash has long expired: it can no longer land
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ success: true });
  });

  it("says 'a few seconds' when the earlier payment is still being sent rather than kept", async () => {
    const first = gate();
    const { guarded, pay } = await setup(async (n) => (n === 1 ? first.wait.then(() => ({})) : {}), 1_000);
    const sending = guarded.settle(await pay(), EXACT);
    await flush();
    const refused = await guarded.settle(await pay(), EXACT);
    expect(refused.errorMessage).toBe("an earlier payment from this account is still being sent; nothing was charged for this one, pay again in a few seconds (at most 89)");
    first.open();
    expect(await sending).toMatchObject({ success: true });
  });

  it("lets the resource server's retry of a pending payment join, and frees the account once it lands", async () => {
    const { guarded, log, c, pay } = await setup((n) => (n === 1 ? PENDING : { transaction: "sig" }));
    const p = await pay();
    expect(await guarded.settle(p, EXACT)).toMatchObject({ errorReason: "settlement_pending" });
    expect(await guarded.settle(p, EXACT)).toMatchObject({ success: true, transaction: "sig" }); // the same payment, again
    c.advance(LANDED_GRACE_MS);
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ success: true });
    expect(log).toHaveLength(6);
  });

  it("keeps a pending payment's lock when its retry throws: that retry sent nothing, but the first send may still land", async () => {
    const { guarded, pay } = await setup((n) => {
      if (n === 2) throw new Error("D1 down");
      return n === 1 ? PENDING : {};
    });
    const p = await pay();
    await guarded.settle(p, EXACT);
    await expect(guarded.settle(p, EXACT)).rejects.toThrow("D1 down");
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ errorReason: "payer_busy" });
    await guarded.landed(p, EXACT); // the app read the chain: it landed
  });

  it("frees the account when the app reads the chain and finds the pending payment landed", async () => {
    const { guarded, c, pay } = await setup((n) => (n === 1 ? PENDING : {}));
    const p = await pay();
    await guarded.settle(p, EXACT);
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ errorReason: "payer_busy" });
    await guarded.landed(p, EXACT);
    c.advance(LANDED_GRACE_MS);
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ success: true });
  });

  it("does not make the lock last longer when a settled payment is sent again", async () => {
    const { guarded, c, pay } = await setup((n) => (n === 2 ? { success: false, errorReason: "duplicate_settlement", transaction: "" } : {}));
    const p = await pay();
    await guarded.settle(p, EXACT);
    c.advance(1_000);
    expect(await guarded.settle(p, EXACT)).toMatchObject({ errorReason: "payer_busy" }); // within the grace it waits, writing nothing
    c.advance(LANDED_GRACE_MS - 1_000);
    expect(await guarded.settle(p, EXACT)).toMatchObject({ errorReason: "duplicate_settlement" }); // after it, the facilitator answers
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ success: true }); // and that answer frees the lock at once
  });

  it("makes a copy of a payment still being sent wait like any other payment, then settles it itself", async () => {
    // The order a resend on timeout can take: the first attempt sends nothing (a lagging RPC node
    // fails its simulation) and frees the lock while the copy waits. The copy then holds the lock
    // itself, so no other payment from the account is simulated while the copy is being sent.
    const first = gate();
    const { guarded, log, c, pay } = await setup(async (n) => (n === 1 ? first.wait.then(() => SIMULATION_FAILED) : {}), 10_000, (n) => n === 2 && first.open());
    const p = await pay();
    const holding = guarded.settle(p, EXACT);
    await flush();
    const copy = guarded.settle(p, EXACT);
    expect(await holding).toMatchObject({ errorReason: SIMULATION_FAILED.errorReason });
    expect(await copy).toMatchObject({ success: true, transaction: "tx2" });
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"]); // never both at once
    const started = c.now();
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ success: true });
    expect(c.now() - started).toBeGreaterThanOrEqual(LANDED_GRACE_MS); // the next one waited for the copy's landing
  });

  it("tells a copy of a payment still being sent to send that payment again, not to sign a new one", async () => {
    const first = gate();
    const { guarded, pay } = await setup(async (n) => (n === 1 ? first.wait.then(() => ({})) : {}));
    const p = await pay();
    const sending = guarded.settle(p, EXACT);
    await flush();
    const copy = await guarded.settle(p, EXACT);
    expect(copy).toMatchObject({ success: false, errorReason: "payer_busy" });
    expect(copy.errorMessage).toBe("this payment is still being sent and may yet go through: send this same payment again in a few seconds (at most 90), rather than signing a new one");
    first.open();
    expect(await sending).toMatchObject({ success: true });
  });

  it("lets a copy join only once the first attempt has ended with a send that may still land", async () => {
    const first = gate();
    const { guarded, log, pay } = await setup(async (n) => (n === 1 ? first.wait.then(() => PENDING) : { transaction: "sig" }), 10_000, (n) => n === 2 && first.open());
    const p = await pay();
    const holding = guarded.settle(p, EXACT);
    await flush();
    const copy = guarded.settle(p, EXACT);
    expect(await holding).toMatchObject({ errorReason: "settlement_pending" });
    expect(await copy).toMatchObject({ success: true, transaction: "sig" }); // joined the kept lock: the same transaction, settled
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("waits with few database queries, well inside a free Worker's 50 a request", async () => {
    const { inner } = facilitator((n) => (n === 1 ? PENDING : {}));
    const c = clock();
    const db = sqlite();
    let queries = 0;
    const counted = { ...db, run: (...a: Parameters<typeof db.run>) => ((queries += 1), db.run(...a)), first: (<T>(...a: Parameters<typeof db.first>) => ((queries += 1), db.first<T>(...a))) as typeof db.first };
    const guarded = feeGuard(inner, MAINNET, payerLock(counted, PAYER_LOCK_TTL_MS, c.now), waitOn(c, 10_000));
    const [source, owner] = await Promise.all([addr(), addr()]);
    await guarded.settle(exact(await dataRequest(source, owner)), EXACT);
    queries = 0;
    const started = c.now();
    expect(await guarded.settle(exact(await dataRequest(source, owner)), EXACT)).toMatchObject({ errorReason: "payer_busy" });
    expect(c.now() - started).toBe(10_000); // it still waits the whole 10 seconds
    expect(queries).toBe(8); // one query an ask: the first, then asks a second, then two seconds apart
  });

  it("frees a deposit's lock only for the deposit's own settle, not its claim's, which carries the same payload", async () => {
    const { inner } = facilitator((n) => (n === 1 ? PENDING : {}));
    const c = clock();
    const guarded = feeGuard(inner, MAINNET, payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now), waitOn(c, 0));
    const [payer, payerToken] = await Promise.all([addr(), addr()]);
    const open = await channelOpen(payer, payerToken);
    await guarded.settle(deposit(open), upto());
    const unstamped = deposit(open, {}); // as the app's failure hook sees it: no type, charged the whole ceiling
    await guarded.landed(unstamped, upto(), "after-handler");
    c.advance(LANDED_GRACE_MS);
    expect(await guarded.settle(deposit(await channelOpen(payer, payerToken)), upto())).toMatchObject({ errorReason: "payer_busy" });
    await guarded.landed(deposit(open, { maxAmount: "99999" }), upto(), "before-handler"); // a deposit, though its amounts differ
    c.advance(LANDED_GRACE_MS);
    expect(await guarded.settle(deposit(await channelOpen(payer, payerToken)), upto())).toMatchObject({ success: true });
  });

  it("keeps the account locked after a send that may have reached the network, and frees it at once when nothing was sent", async () => {
    for (const [result, next] of [
      [{ success: false, errorReason: "invalid_exact_svm_transaction_failed", transaction: "" }, { errorReason: "payer_busy" }],
      [SIMULATION_FAILED, { success: true }],
    ] as [Partial<Settled>, Partial<Settled>][]) {
      const { guarded, c, pay } = await setup((n) => (n === 1 ? result : {}));
      await guarded.settle(await pay(), EXACT);
      c.advance(1);
      expect(await guarded.settle(await pay(), EXACT)).toMatchObject(next);
    }
  });

  it("frees the account when the holder's settle throws: the facilitator catches every send error, so nothing went out", async () => {
    const { guarded, c, pay } = await setup((n) => {
      if (n === 1) throw new Error("D1 down");
      return {};
    });
    await expect(guarded.settle(await pay(), EXACT)).rejects.toThrow("D1 down");
    c.advance(1);
    expect(await guarded.settle(await pay(), EXACT)).toMatchObject({ success: true });
  });

  it("answers the resource server's retry with its own pending answer when the lock could not save that it may land", async () => {
    const { inner, log } = facilitator((n) => (n === 1 ? PENDING : {}));
    const c = clock();
    const base = payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now);
    const flaky: PayerLock = { ...base, keep: async () => { throw new Error("D1 down"); } };
    const guarded = feeGuard(inner, MAINNET, flaky, waitOn(c, 1_000));
    const p = exact(await dataRequest(await addr(), await addr()));
    expect(await guarded.settle(p, EXACT)).toMatchObject(PENDING);
    const before = c.now();
    expect(await guarded.settle(p, EXACT)).toMatchObject(PENDING); // the retry: the same answer, signature and all
    expect(c.now()).toBe(before); // at once: no waiting for a lock it will not get
    expect(log).toEqual(["start 1", "end 1"]);
  });

  it("sends without waiting when the lock cannot be read, as its holder: an outage must not stop sales", async () => {
    const { inner, log } = facilitator(() => ({}));
    const updates: string[] = [];
    const broken: PayerLock = {
      acquire: async () => { throw new Error("D1 down"); },
      release: async () => void updates.push("release"),
      landed: async () => void updates.push("landed"),
      keep: async () => void updates.push("keep"),
    };
    const guarded = feeGuard(inner, MAINNET, broken, { maxMs: 0, stepMs: 250, sleep: flush });
    expect(await guarded.settle(exact(await dataRequest(await addr(), await addr())), EXACT)).toMatchObject({ success: true });
    expect(log).toEqual(["start 1", "end 1"]);
    // Not freed before the send (a take that was written but not answered would then protect nothing):
    // after it, as any holder does. Each update is a no-op if no take was written.
    expect(updates).toEqual(["landed"]);
  });

  it("is busy, never free, when it loses the race to take the lock and cannot read who won", async () => {
    let selects = 0;
    const db = {
      first: async () => {
        if (++selects === 1) return null; // looks free
        throw new Error("D1 timeout"); // who won? cannot tell
      },
      run: async () => ({ changes: 0 }), // the take lost the race
      all: async () => [],
      batch: async () => ({ changes: 0 }),
    } as unknown as Db;
    expect(await payerLock(db).acquire("A", "fp1", "h1")).toEqual({ role: "busy", kept: false, same: false, remainingMs: PAYER_LOCK_TTL_MS });
  });

  it("waits a bounded number of asks even with a zero step", async () => {
    const { inner, log } = facilitator((n) => (n === 1 ? new Promise<Partial<Settled>>(() => undefined) : {}));
    const c = clock();
    const base = payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now);
    let asks = 0;
    const counting: PayerLock = { ...base, acquire: (...a) => ((asks += 1), base.acquire(...a)) };
    const guarded = feeGuard(inner, MAINNET, counting, { maxMs: 50, stepMs: 0, sleep: async (ms) => (c.advance(ms), flush()) });
    const [source, owner] = await Promise.all([addr(), addr()]);
    void guarded.settle(exact(await dataRequest(source, owner)), EXACT); // holds the lock, never finishes
    while (!log.includes("start 1")) await flush(); // it holds the lock and is sending
    asks = 0;
    expect(await guarded.settle(exact(await dataRequest(source, owner)), EXACT)).toMatchObject({ errorReason: "payer_busy" });
    expect(asks).toBeLessThanOrEqual(51);
  });

  it("frees the account at once when the RPC refused the send, and keeps it when the send's fate is unknown", async () => {
    const sendThrew: Partial<Settled> = { success: false, errorReason: "invalid_exact_svm_transaction_failed", transaction: "" };
    for (const refusedByRpc of [true, false]) {
      const { inner } = facilitator((n) => (n === 1 ? sendThrew : {}));
      const c = clock();
      const [source, owner] = await Promise.all([addr(), addr()]);
      const pay = exact(await dataRequest(source, owner));
      const fp = ((await lockFor(pay, EXACT)) as LockTarget).fp;
      const guarded = feeGuard(inner, MAINNET, payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now), waitOn(c, 0), (seen) => refusedByRpc && seen === fp);
      const first = await guarded.settle(pay, EXACT);
      // Either way it stays unnamed, as the facilitator reports it: our signature of it never leaves the server.
      expect(first.transaction).toBe("");
      c.advance(1);
      expect(await guarded.settle(exact(await dataRequest(source, owner)), EXACT)).toMatchObject(refusedByRpc ? { success: true } : { errorReason: "payer_busy" });
    }
  });

  it("refuses, rather than sending alongside, when the lock was seen held and a later read of it fails", async () => {
    const { inner, log } = facilitator(() => ({}));
    let asks = 0;
    const released: string[] = [];
    const flaky: PayerLock = {
      acquire: async () => {
        if (++asks === 1) return { role: "busy", kept: true, same: false, remainingMs: 80_000 };
        throw new Error("D1 timeout");
      },
      release: async (_account, holder) => void released.push(holder), landed: async () => undefined, keep: async () => undefined,
    };
    const guarded = feeGuard(inner, MAINNET, flaky, { maxMs: 10_000, stepMs: 250, sleep: flush });
    expect(await guarded.settle(exact(await dataRequest(await addr(), await addr())), EXACT)).toMatchObject({ success: false, errorReason: "payer_busy" });
    expect(log).toEqual([]); // never sent
    expect(released).toHaveLength(1); // in case the failed read had taken it
  });

  it("answers the resource server's retry with the pending answer even when the lock ran out and another payment took it", async () => {
    const c = clock();
    const other = gate();
    let otherSettle: Promise<Settled> | undefined;
    const [source, owner] = await Promise.all([addr(), addr()]);
    const p = exact(await dataRequest(source, owner));
    const q = exact(await dataRequest(source, owner));
    let guarded: ReturnType<typeof feeGuard>;
    const { inner, log } = facilitator(async (n) => {
      if (n === 1) {
        c.advance(PAYER_LOCK_TTL_MS + 5_000); // this settle ran long, past the lock's time
        otherSettle = guarded.settle(q, EXACT); // and another payment from the account took the lock
        await flush();
        await flush();
        return PENDING;
      }
      return n === 2 ? other.wait.then(() => ({})) : {};
    });
    guarded = feeGuard(inner, MAINNET, payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now), waitOn(c, 10_000));
    expect(await guarded.settle(p, EXACT)).toMatchObject(PENDING);
    expect(await guarded.settle(p, EXACT)).toMatchObject(PENDING); // the retry, at once: the same answer, so the app reads the chain
    expect(log).toEqual(["start 1", "start 2", "end 1"]);
    other.open();
    await otherSettle;
  });

  it("counts only the latest send of a transaction: a later send clears an earlier refusal", async () => {
    const refused = new Map<string, number>();
    const answers: unknown[] = [];
    const signer = watchingRefusals({
      sendTransaction: async (_transaction: string, _network: Network) => {
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return "sig";
      },
    }, refused);
    const tx = await dataRequest(await addr(), await addr());
    const fp = ((await lockFor(exact(tx), EXACT)) as LockTarget).fp;
    const net = MAINNET as Network;
    answers.push(new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "", statusCode: 429 }));
    await expect(signer.sendTransaction(tx, net)).rejects.toBeInstanceOf(SolanaError);
    expect(refused.has(fp)).toBe(true);
    answers.push(new TypeError("fetch failed")); // the same transaction again: this time its fate is unknown
    await expect(signer.sendTransaction(tx, net)).rejects.toThrow("fetch failed");
    expect(refused.has(fp)).toBe(false);
    await expect(signer.sendTransaction("not a transaction", net)).resolves.toBe("sig"); // unreadable bytes never get in the way
  });

  it("tells a send the RPC turned away from one whose fate is unknown", () => {
    const http = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "", statusCode });
    // Turned away before any node took it.
    expect(sendRefusedBy(http(429))).toBe(true);
    expect(sendRefusedBy(http(400))).toBe(true);
    expect(sendRefusedBy(new SolanaError(SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, { __serverMessage: "bad" }))).toBe(true);
    expect(sendRefusedBy(new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE))).toBe(true);
    // May have been forwarded: a 5xx, a timeout, an internal error after forwarding, a node that is behind, a failed connection.
    expect(sendRefusedBy(http(504))).toBe(false);
    expect(sendRefusedBy(http(408))).toBe(false);
    expect(sendRefusedBy(new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, { __serverMessage: "Internal error" }))).toBe(false);
    expect(sendRefusedBy(new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, { numSlotsBehind: 10 }))).toBe(false);
    expect(sendRefusedBy(new TypeError("fetch failed"))).toBe(false);
  });

  it("never holds up a question's claim or refund, even while its account's deposit may still land", async () => {
    const { inner, log } = facilitator((n) => (n === 1 ? PENDING : {}));
    const c = clock();
    const guarded = feeGuard(inner, MAINNET, payerLock(sqlite(), PAYER_LOCK_TTL_MS, c.now), waitOn(c, 0));
    const open = await channelOpen(await addr(), await addr());
    expect(await guarded.settle(deposit(open), upto())).toMatchObject({ errorReason: "settlement_pending" });
    expect(await guarded.settle(deposit(open, { type: "claim", voucherSignature: "v" }), upto("1000"))).toMatchObject({ success: true });
    expect(await guarded.settle(deposit(open, { type: "claim" }), upto("0"))).toMatchObject({ success: true });
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("does not make different accounts wait for each other", async () => {
    const a = gate();
    const { inner, log } = facilitator(async (n) => (n === 1 ? a.wait.then(() => ({})) : {}));
    const guarded = feeGuard(inner, MAINNET, payerLock(sqlite()), { maxMs: 0, stepMs: 250, sleep: flush });
    const first = guarded.settle(exact(await dataRequest(await addr(), await addr())), EXACT);
    await flush();
    expect(await guarded.settle(exact(await dataRequest(await addr(), await addr())), EXACT)).toMatchObject({ success: true });
    a.open();
    await first;
    expect(log).toEqual(["start 1", "start 2", "end 2", "end 1"]);
  });

  it("leaves devnet alone: test money, and the hourly monitor and demo must not queue", async () => {
    const a = gate();
    const { inner, log } = facilitator(async (n) => (n === 1 ? a.wait.then(() => ({})) : {}));
    const guarded = feeGuard(inner, MAINNET, payerLock(sqlite()), { maxMs: 0, stepMs: 250, sleep: flush });
    const [source, owner] = await Promise.all([addr(), addr()]);
    const devnet = { ...EXACT, network: NETWORK } as PaymentRequirements;
    const first = guarded.settle(exact(await dataRequest(source, owner)), devnet);
    await flush();
    expect(await guarded.settle(exact(await dataRequest(source, owner)), devnet)).toMatchObject({ success: true });
    a.open();
    await first;
    expect(log).toEqual(["start 1", "start 2", "end 2", "end 1"]);
  });
});

describe("the app after an unconfirmed mainnet payment", () => {
  let db: Db;
  beforeAll(async () => {
    db = await loadedDb();
  });

  /** A paid mainnet data request whose every settle answers `result`, on a chain that shows the payment landed. */
  async function buyOnce(result: (r: PaymentRequirements) => Settled, guard?: (inner: FacilitatorClient) => FacilitatorClient) {
    const RPC = "http://127.0.0.1:9"; // nothing listens
    const svm = toFacilitatorSvmSigner(await generateKeyPairSigner(), { defaultRpcUrl: RPC });
    const networks = [NETWORK, MAINNET] as Network[];
    const real = new x402Facilitator()
      .register(networks, new ExactFacilitator(svm))
      .register(networks, new UptoFacilitator(svm, { channelStorage: new InMemoryPaymentChannelStorage() }));
    const settles: PaymentPayload[] = [];
    const landed: [PaymentPayload, PaymentRequirements, string][] = [];
    const scripted: FacilitatorClient = {
      verify: async () => ({ isValid: true, payer: "buyer" }),
      settle: async (p, r) => (settles.push(p), result(r)),
      getSupported: async () => real.getSupported() as SupportedResponse,
    };
    const app = await createApp({
      db,
      facilitator: guard ? guard(scripted) : scripted,
      landed: async (p, r, phase) => void landed.push([p, r, phase]),
      llm: async () => { throw new Error("no AI in these tests"); },
      treasury: "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8",
      authorizer: await generateKeyPairSigner(),
      rpcUrl: RPC,
      readChain: async () => { throw new Error("devnet is not used here"); },
      mainnet: { rpcUrl: RPC, readChain: async () => ({ status: "confirmed", received: 10_000_000n, slot: 1 }), solUsd: async () => 72.4 },
      now: () => new Date("2026-10-21T12:00:00Z"),
    });
    const url = `https://api.afriradar.com${PRODUCTS.fund.example}`;
    const challenge = await app.fetch(new Request(url));
    const required = JSON.parse(Buffer.from(challenge.headers.get("PAYMENT-REQUIRED") as string, "base64").toString("utf8"));
    const accepted = required.accepts.find((a: PaymentRequirements) => a.network === MAINNET);
    const transaction = await dataRequest(await addr(), await addr());
    const signature = Buffer.from(JSON.stringify({ x402Version: 2, accepted, resource: required.resource, payload: { transaction } })).toString("base64");
    const res = await app.fetch(new Request(url, { headers: { "PAYMENT-SIGNATURE": signature } }));
    return { res, settles, landed, transaction };
  }

  it("tells the lock the payment landed when the chain shows it, and serves what was bought", async () => {
    const { res, settles, landed, transaction } = await buyOnce((r) => ({ success: false, errorReason: "settlement_pending", transaction: "SIG", network: r.network, payer: "buyer" }));
    expect(res.status).toBe(200);
    expect(settles).toHaveLength(2); // the resource server retries a pending settlement once
    expect(landed).toHaveLength(1);
    expect((landed[0][0].payload as { transaction?: string }).transaction).toBe(transaction);
    expect(landed[0][1].network).toBe(MAINNET);
    expect(landed[0][2]).toBe("after-handler"); // a data request settles after its handler, and its transaction is the buyer's
  });

  it("does the same when the payment was sent but its pending record could not be written", async () => {
    const { res, settles, landed } = await buyOnce((r) => ({
      success: false, errorReason: "invalid_exact_svm_transaction_failed", transaction: "SIG", network: r.network, payer: "buyer",
      errorMessage: "settlement_pending, but failed to persist for retry: D1 down",
    }));
    expect(res.status).toBe(200);
    expect(settles).toHaveLength(1); // not a pending reason, so the resource server does not retry it
    expect(landed).toHaveLength(1);
  });

  it("keeps a send that threw a plain failure: nothing names it, so our signature of it is never published", async () => {
    const { res, settles, landed } = await buyOnce(
      (r) => ({ success: false, errorReason: "invalid_exact_svm_transaction_failed", transaction: "", network: r.network, payer: "buyer" }),
      (inner) => feeGuard(inner, MAINNET, payerLock(sqlite()), { maxMs: 0, stepMs: 250, sleep: flush }),
    );
    expect(res.status).toBe(402);
    expect(JSON.stringify(Object.fromEntries(res.headers))).not.toMatch(/"transaction":"[1-9A-HJ-NP-Za-km-z]{40,}"/);
    expect(settles).toHaveLength(1);
    expect(landed).toHaveLength(0); // never read from chain: it has no transaction to read
  });

  it("keeps a busy refusal out of the public ledger: nothing was sent, so no payment happened", async () => {
    const before = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM payments"))?.n ?? 0;
    const { res } = await buyOnce((r) => ({ success: false, errorReason: "payer_busy", errorMessage: "an earlier payment ...", transaction: "", network: r.network, payer: "" }));
    expect(res.status).toBe(402);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM payments"))?.n ?? 0).toBe(before);
  });

  it("still recovers it when the payer lock could not save that the payment may land", async () => {
    const base = payerLock(sqlite());
    const lock: PayerLock = { ...base, keep: async () => { throw new Error("D1 down"); } };
    const { res, settles, landed } = await buyOnce(
      (r) => ({ success: false, errorReason: "settlement_pending", transaction: "SIG", network: r.network, payer: "buyer" }),
      (inner) => feeGuard(inner, MAINNET, lock, { maxMs: 500, stepMs: 250, sleep: flush }),
    );
    expect(res.status).toBe(200);
    expect(settles).toHaveLength(1); // the guard answered the retry with the first pending answer
    expect(landed).toHaveLength(1);
  });
});
