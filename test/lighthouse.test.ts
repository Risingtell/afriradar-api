// Phantom wraps the payment instruction in Lighthouse guards, before and after it. scripts/patch-x402-svm.mjs
// makes @x402/svm 2.28 accept that, and nothing looser. These tests pin the rules on both payment paths:
// data requests (exact) and question deposits (the upto channel open). The guards are byte for byte the
// ones in a real Phantom question deposit, captured from our Worker log on 20 Nov 2026:
//   limit, price, guard(6) buyer, guard(6) fee payer, guard(6) buyer USDC, guard(6) channel USDC,
//   guard(6) channel, open, memo, guard(6) buyer, guard(10) buyer USDC
// A self-paid Phantom transfer the same day also carried a SetLoadedAccountsDataSizeLimit.
import { describe, expect, it } from "vitest";
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  decompileTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction, getBase64Encoder,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, partiallySignTransaction, partiallySignTransactionMessageWithSigners,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Blockhash, type Instruction, type KeyPairSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { buildOpenPaymentChannelTransaction, PAYMENT_CHANNELS_PROGRAM_ID, verifyOpenTransaction } from "x402-svm-channels";
import { UPTO_OPEN_LIMITS } from "../src/netfee.js";

const LIGHTHOUSE = address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n };

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const on = (data: Uint8Array, ...accounts: Address[]): Instruction => ({
  programAddress: LIGHTHOUSE,
  accounts: accounts.map((a) => ({ address: a, role: AccountRole.READONLY })),
  data,
});
/** A Lighthouse instruction of `kind` (its first byte; 6 = AccountInfoMulti, 10 = TokenAccountMulti, 15 = SysvarClock). */
const guard = (kind: number, size: number, accounts: Address[] = []): Instruction =>
  on(Uint8Array.from({ length: size }, (_, i) => (i === 0 ? kind : 3)), ...accounts);

// Phantom's real guards (20 Nov 2026).
const PHANTOM = {
  noLamports: hex("06040100000000000000000000"), // lamports == 0: the buyer (no SOL), and the two new channel accounts
  ownerSystemNoData: hex("06040203000001000000000000000000"), // owner == System, data length == 0: the fee payer, and the buyer after
  tokenAccountState: hex("06040303010001a50000000000000000081aaa0f8d360f1bafc8704d5e0d1496bf121747016cb994beb1b54d2feef34c0e00a501"), // buyer USDC, before
  tokenAccountAfter: hex("0a04030300000600000000000000000508"), // buyer USDC, after
};
/** SetLoadedAccountsDataSizeLimit, as Phantom sends it on a token transfer (4 MiB). */
const dataLimit: Instruction = { programAddress: COMPUTE_BUDGET, accounts: [], data: Uint8Array.of(4, 0, 0, 64, 0) };
const budget = (units: number, microLamports: bigint): Instruction[] => {
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, units, true);
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, microLamports, true);
  return [{ programAddress: COMPUTE_BUDGET, accounts: [], data: limit }, { programAddress: COMPUTE_BUDGET, accounts: [], data: price }];
};
const memo: Instruction = { programAddress: MEMO, accounts: [], data: new TextEncoder().encode("0123456789abcdef") };
type Who = { buyer: Address; buyerToken: Address; feePayer: Address };

// Lighthouse account-info checks, byte for byte as lighthouse-sdk 2.1.0 encodes them (kind 6 = 6, log level, count, checks).
const u64le = (v: bigint) => [...new Uint8Array(new BigUint64Array([v]).buffer)];
const infoMulti = (...checks: number[][]) => Uint8Array.from([6, 4, checks.length, ...checks.flat()]);
const lamports = (op: number, v: bigint) => [0, ...u64le(v), op]; // op: 0 ==, 1 !=, 2 >, 3 <, 4 >=, 5 <=
const ownerIsSystem = [3, 0, 0];
const noData = [1, ...u64le(0n), 0];
/** Fee-payer checks no other settlement can break: owner, data length, flags, and the trivial "lamports >= 0". */
const safeOnFeePayer = (fp: Address): Instruction[] => [
  on(PHANTOM.ownerSystemNoData, fp),
  on(infoMulti(lamports(4, 0n)), fp),
  on(Uint8Array.from([5, 4, ...ownerIsSystem]), fp), // AssertAccountInfo, one check
  on(infoMulti([5, 1, 0], [6, 1, 0], [7, 0, 0]), fp), // signer, writable, not executable
];
/** Guards that list the fee payer and must be refused: other kinds, any real balance check, malformed bodies. */
const unsafeOnFeePayer = (fp: Address): Instruction[] => [
  ...[2, 3, 7, 8, 9, 10].map((kind) => guard(kind, 26, [fp])),
  guard(6, 26, [fp]), // kind 6 with a body that is not account-info checks
  on(infoMulti(lamports(4, 178_222_674n), ownerIsSystem, noData), fp), // Phantom's floor on a self-paid wallet
  on(infoMulti(lamports(4, 1n)), fp), // any floor above 0
  on(Uint8Array.from([5, 4, ...lamports(4, 1n)]), fp), // the same in AssertAccountInfo
  ...[0, 1, 2, 3, 5].map((op) => on(infoMulti(lamports(op, 0n)), fp)), // ==, !=, >, <, <=
  on(infoMulti([3, 0, 1]), fp), // owner != System
  on(infoMulti(ownerIsSystem, [4, ...u64le(2n ** 64n - 1n), 0]), fp), // rent epoch
  on(infoMulti([8, ...new Array(32).fill(0), 0, 0]), fp), // data hash
  on(Uint8Array.from([6, 4, 0]), fp), // no checks
  on(Uint8Array.from([6, 4, 0x81, ...ownerIsSystem]), fp), // a count that is not one byte
  on(Uint8Array.from([...infoMulti(ownerIsSystem), 9]), fp), // a trailing byte
];
const SAFE_COUNT = safeOnFeePayer(LIGHTHOUSE).length;
const UNSAFE_COUNT = unsafeOnFeePayer(LIGHTHOUSE).length;

// ---------- exact: a data request ----------

type Around = { first?: Instruction[]; before?: Instruction[]; after?: Instruction[] };

async function dataRequest(around: (who: Who) => Around) {
  const [feePayer, buyer, payTo] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const [buyerToken] = await findAssociatedTokenPda({ mint: USDC, owner: buyer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ mint: USDC, owner: payTo.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const transfer = getTransferCheckedInstruction({ source: buyerToken, mint: USDC, destination, authority: buyer, amount: 2_600n, decimals: 6 });
  const a = around({ buyer: buyer.address, buyerToken, feePayer: feePayer.address });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions([...(a.first ?? []), ...budget(200_000, 1n), ...(a.before ?? []), transfer, memo, ...(a.after ?? [])], m),
  );
  const transaction = getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
  const requirements = { scheme: "exact", network: NETWORK, asset: USDC, amount: "2600", payTo: payTo.address, maxTimeoutSeconds: 60, extra: { feePayer: feePayer.address } };
  const facilitator = new ExactFacilitator({ getAddresses: () => [feePayer.address], simulateTransaction: async () => undefined } as never);
  return { buyer: buyer.address, verify: () => facilitator.verify({ x402Version: 2, accepted: requirements, payload: { transaction } } as never, requirements as never) };
}

/** Phantom's guards around a transfer: the same kinds it puts around a channel open, plus its data-size limit. */
const phantomAround = ({ buyer, buyerToken, feePayer }: Who): Around => ({
  before: [on(PHANTOM.noLamports, buyer), on(PHANTOM.ownerSystemNoData, feePayer), on(PHANTOM.tokenAccountState, buyerToken), dataLimit],
  after: [on(PHANTOM.ownerSystemNoData, buyer), on(PHANTOM.tokenAccountAfter, buyerToken)],
});

describe("a data request signed in Phantom (exact)", () => {
  it("passes with Phantom's guards before and after the transfer, one reading the fee payer, plus a data-size limit", async () => {
    const { verify, buyer } = await dataRequest(phantomAround);
    await expect(verify()).resolves.toMatchObject({ isValid: true, payer: buyer });
  });

  it("still passes as Phantom sent it in October and Solflare does: memo, then 2 guards", async () => {
    const { verify } = await dataRequest(({ buyer, buyerToken }) => ({ after: [guard(6, 26, [buyer]), guard(10, 64, [buyerToken])] }));
    await expect(verify()).resolves.toMatchObject({ isValid: true });
  });

  it("lets the fee payer be read only by checks no other settlement can break, before or after the transfer", async () => {
    for (const side of ["before", "after"] as const) {
      for (let i = 0; i < SAFE_COUNT; i++) {
        const reads = await dataRequest(({ feePayer }) => ({ [side]: [safeOnFeePayer(feePayer)[i]!] }));
        await expect(reads.verify(), `${side} safe #${i}`).resolves.toMatchObject({ isValid: true });
      }
      for (let i = 0; i < UNSAFE_COUNT; i++) {
        const { verify } = await dataRequest(({ feePayer }) => ({ [side]: [unsafeOnFeePayer(feePayer)[i]!] }));
        await expect(verify(), `${side} unsafe #${i}`).resolves.toMatchObject({ isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds" });
      }
    }
  });

  it("refuses Lighthouse kinds that are not account, mint or token assertions (memory, delta, clock, unknown)", async () => {
    for (const kind of [0, 1, 4, 15, 18]) {
      const { verify } = await dataRequest(() => ({ after: [guard(kind, 26)] }));
      await expect(verify()).resolves.toMatchObject({ isValid: false, invalidReason: "invalid_exact_svm_payload_invalid_lighthouse_instruction" });
    }
  });

  it("refuses more than 10 guards, a second data-size limit, and a guard before the compute budget", async () => {
    const eleven = await dataRequest(() => ({ before: Array.from({ length: 6 }, () => guard(6, 26)), after: Array.from({ length: 5 }, () => guard(10, 27)) }));
    const twoLimits = await dataRequest(() => ({ before: [dataLimit, guard(6, 26), dataLimit] }));
    const tooEarly = await dataRequest(() => ({ first: [guard(6, 26)] }));
    for (const { verify } of [eleven, twoLimits, tooEarly]) {
      await expect(verify()).resolves.toMatchObject({ isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_instructions_length" });
    }
  });

  it("still refuses any other program next to the transfer", async () => {
    const other: Instruction = { programAddress: address("11111111111111111111111111111111"), accounts: [], data: new Uint8Array([2, 0, 0, 0]) };
    const { verify } = await dataRequest(() => ({ before: [other] }));
    await expect(verify()).resolves.toMatchObject({ isValid: false });
  });
});

// ---------- upto: the channel open of a question ----------

const DEPOSIT = 55_000n;
const OPEN_SLOT = 1_000n;
const GRACE = 3_600;
type Parts = { budget: Instruction[]; open: Instruction; memo: Instruction[]; channel: Address; channelToken: Address } & Who;

/** A question's channel open, rebuilt with its instructions laid out by `layout` and signed again by the buyer. */
async function questionDeposit(layout: (parts: Parts) => Instruction[]) {
  const [feePayer, buyer, authorizer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const [buyerToken] = await findAssociatedTokenPda({ mint: USDC, owner: buyer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const built = await buildOpenPaymentChannelTransaction({
    payer: buyer, payee: feePayer.address, mint: USDC, authorizedSigner: authorizer.address, feePayer: feePayer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS, deposit: DEPOSIT, gracePeriod: GRACE, openSlot: OPEN_SLOT, blockhash: BLOCKHASH,
    computeUnitLimit: 200_000, computeUnitPriceMicroLamports: 1,
  });
  const wire = await reshape(built.transaction, buyer, (parts) => layout({ ...parts, buyer: buyer.address, buyerToken, feePayer: feePayer.address }));
  const verify = () => verifyOpenTransaction(wire, {
    authorizedSigner: authorizer.address, feePayer: feePayer.address, from: buyer.address, maxCap: DEPOSIT, mint: USDC,
    openSlot: OPEN_SLOT, payee: feePayer.address, recentSlot: OPEN_SLOT, recipients: [], tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: GRACE, ...UPTO_OPEN_LIMITS,
  });
  return { verify, channelId: built.channelId };
}

async function reshape(wire: string, buyer: KeyPairSigner, layout: (parts: Omit<Parts, keyof Who>) => Instruction[]) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  const ixs = message.instructions as Instruction[];
  const open = ixs.find((ix) => ix.programAddress === PAYMENT_CHANNELS_PROGRAM_ID) as Instruction;
  const parts = {
    budget: ixs.filter((ix) => ix.programAddress === COMPUTE_BUDGET),
    open,
    memo: ixs.filter((ix) => ix.programAddress === MEMO),
    channel: open.accounts![5]!.address, // open accounts: payer, rent payer, payee, mint, authorizer, channel, payer USDC, channel USDC, ...
    channelToken: open.accounts![7]!.address,
  };
  const rebuilt = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(message.feePayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions(layout(parts), m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransaction([buyer.keyPair], compileTransaction(rebuilt)));
}

describe("a question deposit signed in Phantom (the upto channel open)", () => {
  it("passes exactly as Phantom sent it on 20 Nov: 5 guards before the open (one reads the fee payer), 2 after", async () => {
    const { verify, channelId } = await questionDeposit(({ budget, open, memo, buyer, buyerToken, feePayer, channel, channelToken }) => [
      ...budget,
      on(PHANTOM.noLamports, buyer), on(PHANTOM.ownerSystemNoData, feePayer), on(PHANTOM.tokenAccountState, buyerToken),
      on(PHANTOM.noLamports, channelToken), on(PHANTOM.noLamports, channel),
      open, ...memo,
      on(PHANTOM.ownerSystemNoData, buyer), on(PHANTOM.tokenAccountAfter, buyerToken),
    ]);
    await expect(verify()).resolves.toMatchObject({ channelId });
  });

  it("lets the fee payer be read only by checks no other settlement can break, before or after the open", async () => {
    for (const where of ["before", "after"] as const) {
      const place = (parts: Parts, g: Instruction) => (where === "before" ? [...parts.budget, g, parts.open, ...parts.memo] : [...parts.budget, parts.open, ...parts.memo, g]);
      for (let i = 0; i < SAFE_COUNT; i++) {
        const reads = await questionDeposit((parts) => place(parts, safeOnFeePayer(parts.feePayer)[i]!));
        await expect(reads.verify(), `${where} safe #${i}`).resolves.toMatchObject({ channelId: reads.channelId });
      }
      for (let i = 0; i < UNSAFE_COUNT; i++) {
        const bad = await questionDeposit((parts) => place(parts, unsafeOnFeePayer(parts.feePayer)[i]!));
        await expect(bad.verify(), `${where} unsafe #${i}`).rejects.toThrow(/feePayer must not appear in Lighthouse instruction accounts/);
      }
    }
  });

  it("passes with a data-size limit after the guards or among the compute-budget instructions", async () => {
    const after = await questionDeposit(({ budget, open, memo, buyer }) => [...budget, on(PHANTOM.noLamports, buyer), dataLimit, open, ...memo]);
    const among = await questionDeposit(({ budget, open, memo, buyer }) => [...budget, dataLimit, on(PHANTOM.noLamports, buyer), open, ...memo]);
    await expect(after.verify()).resolves.toMatchObject({ channelId: after.channelId });
    await expect(among.verify()).resolves.toMatchObject({ channelId: among.channelId });
  });

  it("still passes as Phantom sent it before November and Solflare does: memo, then 2 guards", async () => {
    const { verify, channelId } = await questionDeposit(({ budget, open, memo, buyer, buyerToken }) => [...budget, open, ...memo, guard(6, 26, [buyer]), guard(10, 64, [buyerToken])]);
    await expect(verify()).resolves.toMatchObject({ channelId });
  });

  it("refuses Lighthouse kinds that are not account, mint or token assertions, before or after the open", async () => {
    const before = await questionDeposit(({ budget, open, memo }) => [...budget, guard(15, 12), open, ...memo]);
    const after = await questionDeposit(({ budget, open, memo }) => [...budget, open, ...memo, guard(0, 26)]);
    await expect(before.verify()).rejects.toThrow(/must be an account, mint or token assertion/);
    await expect(after.verify()).rejects.toThrow(/must be an account, mint or token assertion/);
  });

  it("refuses more than 10 guards in all", async () => {
    const { verify } = await questionDeposit(({ budget, open, memo }) => [
      ...budget, ...Array.from({ length: 8 }, () => guard(6, 26)), open, ...memo, guard(6, 26), guard(10, 27), guard(6, 26),
    ]);
    await expect(verify()).rejects.toThrow(/at most 10 Lighthouse instructions/);
  });

  it("refuses a second data-size limit", async () => {
    const { verify } = await questionDeposit(({ budget, open, memo }) => [...budget, dataLimit, guard(6, 26), dataLimit, open, ...memo]);
    await expect(verify()).rejects.toThrow(/expected payment-channels open after the ComputeBudget prefix/);
  });

  it("still refuses anything else before the open", async () => {
    const { verify } = await questionDeposit(({ budget, open, memo }) => [...budget, ...memo, open]);
    await expect(verify()).rejects.toThrow(/expected payment-channels open after the ComputeBudget prefix/);
  });
});
