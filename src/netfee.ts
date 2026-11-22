// Mainnet buyers pay their own Solana network fee. The facilitator still signs as fee payer (so a
// buyer needs only USDC, no SOL), but every mainnet price includes the fee of the transactions that
// payment causes, converted to USDC at the live SOL price, and the facilitator refuses any payment
// whose transaction would cost more in fees than the buyer paid for. AfriRadar never pays a
// customer's network fee on mainnet. Devnet stays free of fees: it moves only test money.
import { address, getBase64Encoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress, getTransactionDecoder } from "@solana/kit";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Network fee, in lamports, that each kind of payment is charged for. Measured on mainnet (Oct 2026):
 * a data request is one transaction of 16,000 lamports; a question opens a payment channel (34,000),
 * settles it (10,001) and closes it (about 10,000).
 */
export const FEE_LAMPORTS = { exact: 20_000, upto: 62_000 } as const;
/** The most the buyer-built transaction (the one we sign as fee payer) may cost in fees. */
export const TX_FEE_CAP = { exact: FEE_LAMPORTS.exact, upto: 40_000 } as const;

/**
 * Shape limits for the buyer-built channel open of a question, given to the upto facilitator. feeGuard
 * enforces the exact fee (TX_FEE_CAP.upto); these only bound each field, so they must admit what real
 * wallets send. Phantom opens with 240,000 units at 100,000 microlamports, 2 signatures: 34,000 lamports
 * (mainnet deposits of 22 Oct and 8 Nov 2026). A 75,000 price limit refused every Phantom question.
 */
export const UPTO_OPEN_LIMITS = { maxRequiredSignatures: 2, maxComputeUnits: 400_000, maxPriorityFeeMicroLamports: 125_000 } as const;
export type FeeKind = keyof typeof FEE_LAMPORTS;

/** SOL is priced in $10 steps, rounded up, so the fee changes rarely and never undercharges. */
const SOL_STEP_USD = 10;
/** Used only if the SOL price cannot be read at all: high, so a failure overcharges rather than subsidizes. */
export const SOL_FALLBACK_USD = 300;

/** The network fee for one payment of this kind, in micro-USDC, rounded up to $0.0001. */
export function networkFee(kind: FeeKind, solUsd: number): number {
  const usd = Math.ceil(Math.max(solUsd, 1) / SOL_STEP_USD) * SOL_STEP_USD;
  const micro = (FEE_LAMPORTS[kind] * usd) / 1000; // lamports x $/SOL / 1e9 x 1e6
  return Math.ceil(micro / 100) * 100;
}

// ---------- the SOL price, from Pyth's on-chain price account (no API key) ----------

const PYTH_PUSH_ORACLE = address("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const PYTH_SOL_USD = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Pyth's sponsored price account for a feed (shard 0). */
export async function pythFeedAddress(feedIdHex: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({ programAddress: PYTH_PUSH_ORACLE, seeds: [new Uint8Array([0, 0]), hex(feedIdHex)] });
  return pda;
}

/** Decode a Pyth PriceUpdateV2 account: 8 discriminator, 32 authority, verification level, feed id, price, conf, exponent, publish time. */
export function decodePriceUpdate(data: Uint8Array): { feedId: string; price: number; publishTime: number } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32;
  o += data[o] === 0 ? 2 : 1;
  const feedId = toHex(data.subarray(o, o + 32));
  o += 32;
  const price = v.getBigInt64(o, true);
  o += 16; // price, conf
  const expo = v.getInt32(o, true);
  o += 4;
  return { feedId, price: Number(price) * 10 ** expo, publishTime: Number(v.getBigInt64(o, true)) };
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * Reads SOL/USD from Pyth on mainnet, at most every 10 minutes. If a read fails it uses the last good
 * price while that is under an hour old, otherwise a high price (never one that would undercharge),
 * and waits a minute before trying again.
 */
export function solUsdReader(rpc: Rpc, opts: { now?: () => number; maxAgeMs?: number } = {}): () => Promise<number> {
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAgeMs ?? 10 * 60_000;
  let last: { at: number; usd: number } | undefined;
  let failed: { at: number; usd: number } | undefined;
  let inflight: Promise<number> | undefined;
  const read = async (): Promise<number> => {
    const account = await pythFeedAddress(PYTH_SOL_USD);
    const r = (await rpc("getAccountInfo", [account, { encoding: "base64" }])) as { value?: { owner: string; data: [string, string] } | null };
    if (!r?.value || r.value.owner !== PYTH_RECEIVER) throw new Error("Pyth SOL/USD account missing or not owned by Pyth");
    const p = decodePriceUpdate(Uint8Array.from(getBase64Encoder().encode(r.value.data[0])));
    if (p.feedId !== PYTH_SOL_USD) throw new Error("Pyth account holds a different feed");
    if (!(p.price > 0)) throw new Error("Pyth SOL/USD price is not positive");
    if (now() / 1000 - p.publishTime > 3600) throw new Error("Pyth SOL/USD price is over an hour old");
    return p.price;
  };
  return async () => {
    if (last && now() - last.at < maxAge) return last.usd;
    if (failed && now() - failed.at < 60_000) return failed.usd;
    inflight ??= read()
      .then((usd) => ((last = { at: now(), usd }), (failed = undefined), usd))
      .catch((e) => {
        console.error("SOL price read failed", e);
        const usd = last && now() - last.at < 3_600_000 ? last.usd : Math.max(SOL_FALLBACK_USD, (last?.usd ?? 0) * 1.5);
        failed = { at: now(), usd };
        return usd;
      })
      .finally(() => (inflight = undefined));
    return inflight;
  };
}

// ---------- what a buyer-built transaction would cost us ----------

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/**
 * The fee, in lamports, of a base64 wire transaction: 5,000 per signature plus its priority fee
 * (compute-unit price x compute-unit limit). Without a limit instruction Solana allows 200,000
 * units per other instruction, up to 1,400,000.
 */
export function transactionFee(wireBase64: string): number {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  // x402 clients build legacy or v0 messages; any other layout is refused rather than guessed.
  if (!("instructions" in msg)) throw new Error("unsupported transaction message version");
  const signatures = msg.header.numSignerAccounts;
  let limit: number | undefined;
  let price = 0n;
  let others = 0;
  for (const ix of msg.instructions) {
    const program = msg.staticAccounts[ix.programAddressIndex];
    const d = ix.data ?? new Uint8Array();
    if (program !== COMPUTE_BUDGET) {
      others++;
      continue;
    }
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (d[0] === 2 && d.length >= 5) limit = v.getUint32(1, true);
    else if (d[0] === 3 && d.length >= 9) price = v.getBigUint64(1, true);
  }
  const units = BigInt(limit ?? Math.min(200_000 * others, 1_400_000));
  const priority = (price * units + 999_999n) / 1_000_000n;
  return signatures * 5_000 + Number(priority);
}

// ---------- one send at a time per paying account (mainnet) ----------

/**
 * What acquire found: the lock taken, joined, or held with this much time left: kept, or still being
 * sent, and whether by this same transaction (a copy of a payment that is still being sent).
 */
export type Acquired = { role: "took" } | { role: "joined" } | { role: "busy"; kept: boolean; same: boolean; remainingMs: number };

/**
 * One mainnet send at a time per paying token account. A wallet may add Lighthouse guards that
 * check the buyer's own accounts (Phantom checks the buyer's USDC account byte for byte). Two
 * payments from one account sent at once would both pass the facilitator's simulation, then the
 * second would fail on chain, because the first changed the account its guard checks, and we pay
 * the network fee of every failed transaction. Sent one after the other, the second is simulated
 * again just before it is sent (both facilitators do that, at the "confirmed" commitment they also
 * confirm at), so a stale guard fails in simulation, which costs nothing.
 *
 * A lock belongs to one transaction, and the attempt that takes it holds it. Another attempt of the
 * same transaction (the resource server's retry of a pending one, or a buyer sending it again) joins
 * only once the lock is kept: the first attempt ended and its send may still land. Joining is then
 * safe, because one transaction cannot land twice and a kept lock is freed only by proof that it
 * landed (or by running out). While the first attempt is still in flight, another attempt of it
 * waits like any other payment, so only the holder decides that nothing was sent. Nothing ever
 * makes a lock last longer.
 *
 * Locked: sends of a transaction the buyer built (a data request; a question's deposit). Not
 * locked: a question's claim and refund, which we build and which carry no guards of the buyer's.
 * What is left is what every fee-paying service has: one failed send at most per payment the buyer
 * makes, by moving their own money (or by a claim's refund landing) while that payment is in flight.
 *
 * A send the RPC refused (it answered with an error, so nothing reached the network) frees the
 * account at once. A send whose outcome is unknown (the connection failed) holds the account until
 * it can no longer land, or the chain shows it did, which also keeps a buyer from paying twice for
 * one purchase. A payment redeemed later at /v1/redeem does not free the lock early; it runs out on
 * its own. When the lock itself cannot be read, the payment is sent without it: a database outage
 * must not stop sales.
 */
export interface PayerLock {
  /**
   * Takes the lock on `account` for transaction `fp`: "took" (it was free or its time ran out, and
   * `holder` now holds it), "joined" (it is kept for this same transaction), or "busy" (held for a
   * different transaction, or this one is still being sent).
   */
  acquire(account: string, fp: string, holder: string): Promise<Acquired>;
  /** The holder that took the lock frees it now, unless a send of its transaction may still land. */
  release(account: string, holder: string): Promise<void>;
  /** Transaction `fp` is final: its lock runs out within `afterMs`, whichever attempt holds it. Never lengthens it. */
  landed(account: string, fp: string, afterMs: number): Promise<void>;
  /**
   * The holder's send of transaction `fp` may still land: from now only `landed` or the lock's own
   * time frees it. Only the holder marks it: a copy joins a lock that is already kept.
   */
  keep(account: string, fp: string, holder: string): Promise<void>;
}

/** How long a settlement waits for the same account's previous one before it is refused. */
export type LockWait = { maxMs: number; stepMs: number; sleep: (ms: number) => Promise<void> };
export const LOCK_WAIT: LockWait = { maxMs: 10_000, stepMs: 250, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
/** After a transaction lands, time for every RPC node to see it before the next one is simulated. */
export const LANDED_GRACE_MS = 2_000;
/** A kept lock frees only when its transaction lands or the lock runs out: no need to ask often. */
const KEPT_POLL_MS = 1_000;
/** The longest step between asks while waiting; steps double from LockWait.stepMs up to this. */
const MAX_POLL_MS = 2_000;
/**
 * How long this isolate remembers a settle that may still land, for the resource server's retry of it:
 * no longer than its lock lives (PAYER_LOCK_TTL_MS), so a later attempt is never answered for it.
 */
const UNCONFIRMED_MEMORY_MS = 90_000;
/** The resource server's retry of a pending settlement comes at once, in the same request: well inside this. */
const RETRY_WINDOW_MS = 5_000;

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const TRANSFER_CHECKED = 12;
/** @x402/svm's payment-channel program (its PAYMENT_CHANNELS_PROGRAM_ID, which it does not export). */
const CHANNEL_PROGRAM = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";
/** Where a payment-channel instruction keeps the payer's token account: open (1) at 6, top_up (3) at 2. */
const CHANNEL_PAYER_TOKEN_SLOT = new Map([[1, 6], [3, 2]]);

/** exact carries `transaction`; an upto payload carries the buyer's channel open as `openTransaction`. */
const buyerBuiltTx = (payload: PaymentPayload): unknown => {
  const p = (payload.payload ?? {}) as { transaction?: unknown; openTransaction?: unknown };
  return p.transaction ?? p.openTransaction;
};

/**
 * The buyer-built transaction this settle sends, if any: a data request's transaction, or a
 * question's deposit (its channel open). A question's claim and refund send transactions we build.
 * Tells a deposit from a claim the way the upto facilitator does.
 */
function sentByBuyer(payload: PaymentPayload, req: PaymentRequirements): unknown {
  const raw: unknown = payload.payload;
  if (!raw || typeof raw !== "object") return undefined; // not a payment payload: the facilitator refuses it
  const p = raw as { transaction?: unknown; openTransaction?: unknown; type?: unknown; maxAmount?: unknown };
  if (req.scheme !== "upto") return p.transaction;
  if (p.type === "deposit") return p.openTransaction;
  if (p.type === "claim" || "voucherSignature" in p) return undefined;
  try {
    return BigInt(req.amount) === BigInt(String(p.maxAmount)) ? p.openTransaction : undefined;
  } catch {
    return undefined;
  }
}

type Compiled = ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
/** debitedAccount's answer when the account is named through an address lookup table. */
const IN_LOOKUP_TABLE = Symbol("in a lookup table");

/**
 * The token account a transaction pays from: a transfer's source, or the payer token account of a
 * channel open or top-up. Keyed on the account, not the signer, so an owner and a delegate of one
 * account still wait for each other. null when there is neither: the facilitator then refuses the
 * payment before sending (its smart-wallet path, which moves money inside another program, is off
 * in worker.ts; turning it on would need this to learn that path's source account).
 */
function debitedAccount(msg: Compiled): string | typeof IN_LOOKUP_TABLE | null {
  const accounts = msg.staticAccounts;
  for (const ix of "instructions" in msg ? msg.instructions : []) {
    const program = accounts[ix.programAddressIndex];
    const kind = ix.data?.[0];
    const slot = program && TOKEN_PROGRAMS.has(program) && kind === TRANSFER_CHECKED ? 0 : program === CHANNEL_PROGRAM && kind !== undefined ? CHANNEL_PAYER_TOKEN_SLOT.get(kind) : undefined;
    const at = slot === undefined ? undefined : ix.accountIndices?.[slot];
    if (at !== undefined) return accounts[at] ?? IN_LOOKUP_TABLE; // past the static accounts: from a lookup table
  }
  return null;
}

export type LockTarget = { account: string; fp: string };

/** A transaction's fingerprint: the SHA-256 of its message, which every attempt and every copy of it share. */
export async function fingerprint(messageBytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", messageBytes)));
}

/**
 * What a settle locks: the account it debits, and a fingerprint of its transaction (the same
 * payment sent again is the same transaction). null when the settle sends no transaction the buyer
 * built, or one that cannot be read (the facilitator then refuses it before sending anything).
 * `refuse` when the account is named through a lookup table, which the facilitator would resolve
 * but this lock cannot, so a wallet cannot dodge it that way. Real wallets name it directly.
 */
export async function lockFor(payload: PaymentPayload, req: PaymentRequirements): Promise<LockTarget | { refuse: string } | null> {
  const wire = sentByBuyer(payload, req);
  if (typeof wire !== "string") return null;
  let messageBytes: Uint8Array<ArrayBuffer>;
  let account: string | typeof IN_LOOKUP_TABLE | null;
  try {
    messageBytes = new Uint8Array(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
    account = debitedAccount(getCompiledTransactionMessageDecoder().decode(messageBytes));
  } catch {
    return null;
  }
  if (account === IN_LOOKUP_TABLE) return { refuse: "it pays from a token account named through an address lookup table; name the account in the transaction itself" };
  if (!account) return null;
  return { account, fp: await fingerprint(messageBytes) };
}

type Settled = Awaited<ReturnType<FacilitatorClient["settle"]>>;
type Verified = Awaited<ReturnType<FacilitatorClient["verify"]>>;

/** What a settle result says of its transaction: final (its lock may run out after `final` ms), "maybe" still landing, or "unsent" by this attempt. */
export type LockOutcome = { final: number } | "maybe" | "unsent";

/**
 * Reads a settle result for the lock, against @x402/svm 2.28.0's settle results. Where the library
 * cannot tell, it errs on "maybe": when its send step throws, signing (which does not fail with a
 * local key) and sending share one error.
 */
export function lockOutcome(r: Settled): LockOutcome {
  if (r.success) return { final: LANDED_GRACE_MS };
  const why = r.errorReason ?? "";
  const msg = r.errorMessage ?? "";
  if (why === "settlement_pending") return "maybe";
  if (msg.startsWith("settlement_pending, but failed to persist")) return "maybe"; // sent, not confirmed
  if (msg.startsWith("Transaction failed onchain")) return { final: 0 }; // landed and failed: it changed nothing of the buyer's
  if (why === "invalid_upto_svm_channel_already_open") return { final: LANDED_GRACE_MS }; // the channel exists: this open has landed, or never can
  // Another attempt of the same payment in this isolate sent it, or is sending it. Read as unsent, so a
  // client resending a payment that already settled does not lock its account for a minute and a half.
  // The cost: if that other attempt is a send made without the lock (a database outage) and still in
  // flight, the account is free while it may land.
  if (why === "duplicate_settlement") return "unsent";
  const sendFailed = why === "invalid_exact_svm_transaction_failed" || why === "invalid_upto_svm_channel_broadcast";
  if (sendFailed && !msg.startsWith("failed to durably record the channel before broadcast")) return "maybe"; // it may have reached the network
  return r.transaction ? { final: LANDED_GRACE_MS } : "unsent"; // landed and a later check failed, or refused before sending
}

/**
 * feeGuard's facilitator, plus `landed`: frees the lock kept for an unconfirmed payment once the
 * chain shows it landed. `phase` is the settle's: on a question only the deposit, settled before the
 * handler, sends a transaction the buyer built; its claim and refund carry the same payload.
 */
export type GuardedFacilitator = FacilitatorClient & { landed(payload: PaymentPayload, req: PaymentRequirements, phase?: string): Promise<void> };

const errText = (e: unknown) => String((e as Error)?.message ?? e);

/**
 * Wraps the facilitator so a mainnet payment is refused before we sign anything if its
 * transaction would cost more in network fees than the buyer was charged for, and, given a
 * `lock`, so one account's mainnet payments are sent one at a time (see PayerLock).
 * `sendRefused` says whether the RPC refused the send of a transaction, by fingerprint (worker.ts
 * watches the fee payer's sends): then nothing went out, and the account is free at once. A send
 * that threw otherwise is left unnamed, as the facilitator reports it: naming it would hand out our
 * fee payer's signature of a transaction we never saw land.
 */
export function feeGuard(
  inner: FacilitatorClient,
  mainnet: string,
  lock?: PayerLock,
  wait: LockWait = LOCK_WAIT,
  sendRefused?: (fp: string) => boolean,
): GuardedFacilitator {
  const check = (payload: PaymentPayload, req: PaymentRequirements): string | null => {
    if (req.network !== mainnet) return null;
    const tx = buyerBuiltTx(payload);
    if (tx === undefined) return null; // no buyer-built transaction in this payload: nothing for us to sign
    if (typeof tx !== "string") return "transaction could not be read";
    const kind: FeeKind = req.scheme === "upto" ? "upto" : "exact";
    let fee: number;
    try {
      fee = transactionFee(tx);
    } catch {
      return "transaction could not be read";
    }
    return fee > TX_FEE_CAP[kind] ? `transaction fee ${fee} lamports is above the ${TX_FEE_CAP[kind]} the price covers; lower its priority fee` : null;
  };
  const lockOf = async (p: PaymentPayload, r: PaymentRequirements) => (lock && r.network === mainnet ? lockFor(p, r) : null);
  const note = (what: string, account: string) => (e: unknown) => console.warn(JSON.stringify({ payerLock: what, account, error: errText(e) }));
  const refused = (r: PaymentRequirements, errorReason: string, errorMessage: string) =>
    ({ success: false, errorReason, errorMessage, transaction: "", network: r.network, payer: "" }) as Settled;
  // This isolate's settles that may still land, by transaction. The resource server retries a pending
  // settlement once, at once, in the same request. If the lock cannot let that retry in (its keep was
  // not saved, or it ran out and another payment took it), the retry gets the same pending answer, so
  // the app still reads the chain for it. The lock may fail open on its own errors; it must never turn
  // a payment that can be recovered into one that cannot.
  const unconfirmed = new Map<string, { result: Settled; at: number }>();
  const remember = (fp: string, result: Settled) => {
    const at = Date.now();
    for (const [k, v] of unconfirmed) if (at - v.at >= UNCONFIRMED_MEMORY_MS) unconfirmed.delete(k);
    unconfirmed.set(fp, { result, at });
  };
  const recalled = (fp: string, maxAgeMs = UNCONFIRMED_MEMORY_MS) => {
    const seen = unconfirmed.get(fp);
    return seen && Date.now() - seen.at < maxAgeMs ? seen.result : undefined;
  };
  // The answer a busy lock gives this payment instead of a refusal: its first attempt's pending answer,
  // when the lock is held for this same payment, or when that answer is only moments old (the
  // resource server's retry, even if the lock ran out meanwhile and another payment took it).
  const answerFor = (got: Acquired, fp: string) => (got.role === "busy" && got.same ? recalled(fp) : undefined) ?? recalled(fp, RETRY_WINDOW_MS);
  return {
    verify: async (p, r) => {
      const fee = check(p, r);
      if (fee) return { isValid: false, invalidReason: "network_fee_above_price", invalidMessage: fee, payer: "" } as Verified;
      const on = await lockOf(p, r);
      if (on && "refuse" in on) return { isValid: false, invalidReason: "payment_account_in_lookup_table", invalidMessage: on.refuse, payer: "" } as Verified;
      return inner.verify(p, r);
    },
    settle: async (p, r) => {
      const fee = check(p, r);
      if (fee) return refused(r, "network_fee_above_price", fee);
      const on = await lockOf(p, r);
      if (on && "refuse" in on) return refused(r, "payment_account_in_lookup_table", on.refuse);
      if (!lock || !on) return inner.settle(p, r);
      const holder = crypto.randomUUID();
      let got: Acquired = { role: "busy", kept: false, same: false, remainingMs: 0 };
      let read = false;
      try {
        got = await lock.acquire(on.account, on.fp, holder);
        read = true;
        // Asks less and less often (each ask is a database query), a kept lock no more than once a
        // second: the chain read of its own payment may still free it within the wait.
        for (let waited = 0, asks = 0; got.role === "busy" && !answerFor(got, on.fp) && waited < wait.maxMs; asks++) {
          const step = Math.max(1, Math.min(Math.max(wait.stepMs * 2 ** asks, got.kept ? KEPT_POLL_MS : 0), MAX_POLL_MS, wait.maxMs - waited));
          await wait.sleep(step);
          waited += step;
          got = await lock.acquire(on.account, on.fp, holder);
        }
      } catch (e) {
        if (read) {
          // It was read, held by another payment that may still land: one failed read later must not
          // send alongside it.
          note("could not read the lock again while waiting; payment refused", on.account)(e);
          await lock.release(on.account, holder).catch(() => undefined); // in case that read took it and only its answer was lost
          return refused(r, "payer_busy", "an earlier payment from this account is still being sent; nothing was charged for this one, pay again in a few seconds");
        }
        // Fail open: a database outage must not stop sales. Send as the holder: if the take was written
        // and only its answer lost, the lock then protects this send and is freed after it as usual;
        // if nothing was written, those updates do nothing.
        note("could not read the lock; sending without waiting for it", on.account)(e);
        got = { role: "took" };
      }
      if (got.role === "busy") {
        // The lock is held for this same payment (its first attempt could not save that it may land):
        // the resource server's retry gets that attempt's answer, so the app still reads the chain.
        const again = answerFor(got, on.fp);
        if (again) return again;
        const secs = Math.max(1, Math.ceil(got.remainingMs / 1000));
        return refused(r, "payer_busy", got.same
          ? `this payment is still being sent and may yet go through: send this same payment again in a few seconds (at most ${secs}), rather than signing a new one`
          : got.kept
            ? `an earlier payment from this account may still land on chain; nothing was charged for this one, pay again in ${secs} second${secs === 1 ? "" : "s"}`
            : `an earlier payment from this account is still being sent; nothing was charged for this one, pay again in a few seconds (at most ${secs})`);
      }
      const role = got.role;
      // A settle that throws sent nothing in this attempt: the facilitator catches every send error.
      let outcome: LockOutcome = "unsent";
      try {
        const result = await inner.settle(p, r);
        outcome = lockOutcome(result);
        // The send threw: if the RPC turned it away, nothing went out.
        if (outcome === "maybe" && !result.transaction && sendRefused?.(on.fp)) outcome = "unsent";
        // Not refused: it may land, unnamed. Logged (never published) so a later landing can be matched.
        else if (outcome === "maybe" && !result.transaction) {
          console.warn(JSON.stringify({ payerLock: "a send threw and may still land; its account stays locked until it can no longer land", account: on.account, fp: on.fp }));
        }
        if (outcome === "maybe" && result.transaction) remember(on.fp, result);
        else if (typeof outcome === "object") unconfirmed.delete(on.fp);
        return result;
      } finally {
        const update = outcome === "maybe" ? (role === "took" ? lock.keep(on.account, on.fp, holder) : undefined) // a copy joined a lock already kept
          : outcome !== "unsent" ? lock.landed(on.account, on.fp, outcome.final)
          : role === "took" ? lock.release(on.account, holder)
          : undefined; // a joiner that sent nothing leaves the lock to the attempt that holds it
        await update?.catch(note("could not update the lock; it runs out on its own", on.account));
      }
    },
    getSupported: () => inner.getSupported(),
    landed: async (p, r, phase) => {
      if (r.scheme === "upto" && phase !== undefined && phase !== "before-handler") return; // a claim or refund: ours, never locked
      // Before the handler, a question's settle is its deposit, whatever the amounts say (the app sees the
      // payload before the server stamps it).
      const payload = r.scheme === "upto" && phase === "before-handler" ? ({ ...p, payload: { ...(p.payload as object), type: "deposit" } } as PaymentPayload) : p;
      const on = await lockOf(payload, r);
      if (!lock || !on || "refuse" in on) return;
      unconfirmed.delete(on.fp);
      await lock.landed(on.account, on.fp, LANDED_GRACE_MS).catch(note("could not free the lock; it runs out on its own", on.account));
    },
  };
}
