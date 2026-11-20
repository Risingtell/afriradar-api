// Phantom wraps the payment instruction in Lighthouse guards and adds a compute-budget instruction.
// scripts/patch-x402-svm.mjs makes @x402/svm 2.28 accept that layout, and nothing looser. These tests
// pin the rules on both payment paths: data requests (exact) and question deposits (the upto open).
// The Phantom layout is the one seen on mainnet on 20 Nov 2026 (e.g. transaction P2UUZAeV...):
//   limit, price, guard(10, 17 B), guard(6, 52 B), SetLoadedAccountsDataSizeLimit, <payment>, memo, guard(6, 26 B), guard(10, 27 B)
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

/** A Lighthouse instruction of `kind` (its first byte; 6 = AccountInfoMulti, 10 = TokenAccountMulti, 15 = SysvarClock). */
const guard = (kind: number, size: number, accounts: Address[] = []): Instruction => ({
  programAddress: LIGHTHOUSE,
  accounts: accounts.map((a) => ({ address: a, role: AccountRole.READONLY })),
  data: Uint8Array.from({ length: size }, (_, i) => (i === 0 ? kind : 3)),
});
/** SetLoadedAccountsDataSizeLimit, exactly as Phantom sends it (4 MiB). */
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
    (m) => appendTransactionMessageInstructions([...(a.first ?? []), ...budget(80_000, 100_000n), ...(a.before ?? []), transfer, memo, ...(a.after ?? [])], m),
  );
  const transaction = getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
  const requirements = { scheme: "exact", network: NETWORK, asset: USDC, amount: "2600", payTo: payTo.address, maxTimeoutSeconds: 60, extra: { feePayer: feePayer.address } };
  const facilitator = new ExactFacilitator({ getAddresses: () => [feePayer.address], simulateTransaction: async () => undefined } as never);
  return { buyer: buyer.address, verify: () => facilitator.verify({ x402Version: 2, accepted: requirements, payload: { transaction } } as never, requirements as never) };
}

// Lighthouse account-info checks (AssertAccountInfoMulti, kind 6), byte for byte as lighthouse-sdk 2.1.0 encodes them.
const u64le = (v: bigint) => [...new Uint8Array(new BigUint64Array([v]).buffer)];
const infoMulti = (...checks: number[][]) => Uint8Array.from([6, 4, checks.length, ...checks.flat()]);
const lamports = (op: number, v: bigint) => [0, ...u64le(v), op]; // op: 0 ==, 2 >, 3 <, 4 >=, 5 <=
const ownerIsSystem = [3, 0, 0];
const noData = [1, ...u64le(0n), 0];
const rentEpoch = [4, ...u64le(2n ** 64n - 1n), 0];
const onFeePayer = (data: Uint8Array, feePayer: Address): Instruction => ({ programAddress: LIGHTHOUSE, accounts: [{ address: feePayer, role: AccountRole.READONLY }], data });
/**
 * Phantom's last guard reads the fee payer, our facilitator: "lamports >= X, owner System, data length 0"
 * (mainnet, 20 Nov 2026), X = its simulated balance minus a 0.055-0.09 SOL margin. Our fee payer holds
 * about 0.01 SOL, so X should come out as 0.
 */
const phantomFeePayerCheck = (feePayer: Address) => onFeePayer(infoMulti(lamports(4, 0n), ownerIsSystem, noData), feePayer);
const RENT_EXEMPT_MIN = 890_880n; // lamports a system account must keep; below it a transaction fails anyway
/** Fee-payer checks no other settlement can break: owner, data length, flags, a floor at or under the rent minimum. */
const safeOnFeePayer = (fp: Address): Instruction[] => [
  phantomFeePayerCheck(fp),
  onFeePayer(infoMulti(lamports(4, RENT_EXEMPT_MIN)), fp),
  onFeePayer(infoMulti(lamports(2, RENT_EXEMPT_MIN - 1n)), fp),
  onFeePayer(Uint8Array.from([5, 4, ...ownerIsSystem]), fp), // AssertAccountInfo, one check
  onFeePayer(infoMulti([5, 1, 0], [6, 1, 0], [7, 0, 0]), fp), // signer, writable, not executable
];
/** Guards that list the fee payer and must be refused: other kinds, and balance checks a settlement could break. */
const unsafeOnFeePayer = (fp: Address): Instruction[] => [
  ...[2, 3, 7, 8, 9, 10].map((kind) => guard(kind, 26, [fp])),
  onFeePayer(infoMulti(lamports(4, 178_222_674n), ownerIsSystem, noData), fp), // a real Phantom floor on a richer fee payer
  onFeePayer(infoMulti(lamports(4, RENT_EXEMPT_MIN + 1n)), fp), // floor just above the rent minimum
  onFeePayer(infoMulti(lamports(2, RENT_EXEMPT_MIN)), fp), // "> rent minimum" = ">= rent minimum + 1"
  onFeePayer(infoMulti(lamports(4, 2n ** 40n)), fp), // a floor that needs the high bytes
  ...[0, 1, 3, 5].map((op) => onFeePayer(infoMulti(lamports(op, 0n)), fp)), // ==, !=, <, <=
  onFeePayer(infoMulti([3, 0, 1]), fp), // owner != System
  onFeePayer(infoMulti(ownerIsSystem, rentEpoch), fp), // rent epoch
  onFeePayer(Uint8Array.from([...infoMulti(ownerIsSystem), 9]), fp), // a trailing byte
];
const SAFE_COUNT = safeOnFeePayer(LIGHTHOUSE).length;
const UNSAFE_COUNT = unsafeOnFeePayer(LIGHTHOUSE).length;

const phantomAround = ({ buyer, buyerToken, feePayer }: Who): Around => ({
  before: [guard(10, 17, [buyerToken]), guard(6, 52, [buyer]), dataLimit],
  after: [phantomFeePayerCheck(feePayer), guard(10, 27, [buyerToken])],
});

describe("a data request signed in Phantom (exact)", () => {
  it("passes as Phantom sends it now: guards before and after the transfer, plus a data-size limit", async () => {
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
        await expect(verify(), `${side} #${i}`).resolves.toMatchObject({ isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds" });
      }
    }
  });

  it("refuses Lighthouse kinds that are not account, mint or token assertions (memory, delta, clock, unknown)", async () => {
    for (const kind of [0, 1, 4, 15, 18]) {
      const { verify } = await dataRequest(() => ({ after: [guard(kind, 26)] }));
      await expect(verify()).resolves.toMatchObject({ isValid: false, invalidReason: "invalid_exact_svm_payload_invalid_lighthouse_instruction" });
    }
  });

  it("refuses more than 6 guards, a second data-size limit, and a guard before the compute budget", async () => {
    const seven = await dataRequest(() => ({ before: [guard(6, 26), guard(10, 27), guard(6, 26), guard(10, 27)], after: [guard(6, 26), guard(10, 27), guard(6, 26)] }));
    const twoLimits = await dataRequest(() => ({ before: [dataLimit, guard(6, 26), dataLimit] }));
    const tooEarly = await dataRequest(() => ({ first: [guard(6, 26)] }));
    for (const { verify } of [seven, twoLimits, tooEarly]) {
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
type Parts = { budget: Instruction[]; open: Instruction; memo: Instruction[] } & Who;

/** A question's channel open, rebuilt with its instructions laid out by `layout` and signed again by the buyer. */
async function questionDeposit(layout: (parts: Parts) => Instruction[]) {
  const [feePayer, buyer, authorizer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const [buyerToken] = await findAssociatedTokenPda({ mint: USDC, owner: buyer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const built = await buildOpenPaymentChannelTransaction({
    payer: buyer, payee: feePayer.address, mint: USDC, authorizedSigner: authorizer.address, feePayer: feePayer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS, deposit: DEPOSIT, gracePeriod: GRACE, openSlot: OPEN_SLOT, blockhash: BLOCKHASH,
    computeUnitLimit: 240_000, computeUnitPriceMicroLamports: 100_000,
  });
  const wire = await reshape(built.transaction, buyer, (parts) => layout({ ...parts, buyer: buyer.address, buyerToken, feePayer: feePayer.address }));
  const verify = () => verifyOpenTransaction(wire, {
    authorizedSigner: authorizer.address, feePayer: feePayer.address, from: buyer.address, maxCap: DEPOSIT, mint: USDC,
    openSlot: OPEN_SLOT, payee: feePayer.address, recentSlot: OPEN_SLOT, recipients: [], tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: GRACE, ...UPTO_OPEN_LIMITS,
  });
  return { verify, channelId: built.channelId };
}

async function reshape(wire: string, buyer: KeyPairSigner, layout: (parts: { budget: Instruction[]; open: Instruction; memo: Instruction[] }) => Instruction[]) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
  const ixs = message.instructions as Instruction[];
  const parts = {
    budget: ixs.filter((ix) => ix.programAddress === COMPUTE_BUDGET),
    open: ixs.find((ix) => ix.programAddress === PAYMENT_CHANNELS_PROGRAM_ID) as Instruction,
    memo: ixs.filter((ix) => ix.programAddress === MEMO),
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
  it("passes as Phantom sends it now: guards before and after the open (the last reads the fee payer), plus a data-size limit", async () => {
    const { verify, channelId } = await questionDeposit(({ budget, open, memo, buyer, buyerToken, feePayer }) => [
      ...budget, guard(10, 17, [buyerToken]), guard(6, 52, [buyer]), dataLimit, open, ...memo, phantomFeePayerCheck(feePayer), guard(10, 27, [buyerToken]),
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
        await expect(bad.verify(), `${where} #${i}`).rejects.toThrow(/feePayer must not appear in Lighthouse instruction accounts/);
      }
    }
  });

  it("passes with the data-size limit among the compute-budget instructions", async () => {
    const { verify, channelId } = await questionDeposit(({ budget, open, memo, buyer }) => [...budget, dataLimit, guard(6, 52, [buyer]), open, ...memo]);
    await expect(verify()).resolves.toMatchObject({ channelId });
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

  it("refuses more than 6 guards in all", async () => {
    const { verify } = await questionDeposit(({ budget, open, memo }) => [
      ...budget, guard(6, 26), guard(10, 27), guard(6, 26), guard(10, 27), open, ...memo, guard(6, 26), guard(10, 27), guard(6, 26),
    ]);
    await expect(verify()).rejects.toThrow(/at most 6 Lighthouse instructions/);
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
