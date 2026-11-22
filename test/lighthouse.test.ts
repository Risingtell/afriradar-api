// Phantom wraps the payment instruction in Lighthouse guards, before and after it. scripts/patch-x402-svm.mjs
// makes @x402/svm 2.28 accept that, and nothing looser. These tests pin the rules on both payment paths:
// data requests (exact) and question deposits (the upto channel open). The guards are byte for byte the
// ones real wallets sent us on mainnet (20 Nov 2026 unless noted):
//   Phantom data request 4ft9Mzwp9d: limit, price, guard(10) treasury USDC, guard(6) fee payer,
//     guard(6) buyer USDC, transfer, memo, guard(10) buyer USDC
//   Phantom question deposit (from our Worker log): limit, price, guard(6) buyer, guard(6) fee payer,
//     guard(6) buyer USDC, guard(6) channel USDC, guard(6) channel, open, memo, guard(6) buyer, guard(10) buyer USDC
//   Solflare data request yCobCg (18 Nov): ..., transfer, memo, guard(6) buyer, guard(10) buyer USDC
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
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
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

// Real wallet guards.
const REAL = {
  noLamports: hex("06040100000000000000000000"), // Phantom: lamports == 0 (buyer with no SOL, the two new channel accounts)
  ownerSystemNoData: hex("06040203000001000000000000000000"), // Phantom: owner == System, data length == 0 (fee payer; buyer after)
  tokenNoDelegate: hex("0a04030300000600000000000000000508"), // Phantom: no delegate, delegated amount <= 0, derived owner (treasury; buyer USDC after)
  buyerUsdcBefore: hex("06040303010001a500000000000000000815ef36b441ae9f8cf8248c1acf0affd86fbd62220165d377200973f7def457c700a501"), // Phantom: owner Token, length 165, data hash
  openBuyerUsdcBefore: hex("06040303010001a50000000000000000081aaa0f8d360f1bafc8704d5e0d1496bf121747016cb994beb1b54d2feef34c0e00a501"),
  solflareBuyer: hex("06050300042f1800000000000403000001000000000000000000"), // Solflare: lamports, owner, data length on the buyer
  solflareBuyerUsdc: hex("0a050608026910020000000000040300000600000000000000000001a09cdc7aa79d1c40733d890d4c0b81e5f28e8fceb6d58499f240398fea9c3dc100070000"), // includes "amount >= X"
};
/** SetLoadedAccountsDataSizeLimit, as Phantom sends it on a self-paid token transfer (4 MiB). */
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
type Who = { buyer: Address; buyerToken: Address; feePayer: Address; treasuryToken: Address };

// Lighthouse checks, byte for byte as lighthouse-sdk 2.1.0 encodes them.
const u64le = (v: bigint) => [...new Uint8Array(new BigUint64Array([v]).buffer)];
const infoMulti = (...checks: number[][]) => Uint8Array.from([6, 4, checks.length, ...checks.flat()]);
const tokenMulti = (...checks: number[][]) => Uint8Array.from([10, 4, checks.length, ...checks.flat()]);
const lamports = (op: number, v: bigint) => [0, ...u64le(v), op]; // op: 0 ==, 1 !=, 2 >, 3 <, 4 >=, 5 <=
const ownerIsSystem = [3, 0, 0];
const ownerIsToken = [3, 1, 0];
const noData = [1, ...u64le(0n), 0];
const tokenAccountLength = [1, ...u64le(165n), 0];
const tokenAmount = (op: number, v: bigint) => [2, ...u64le(v), op];
/** Fee-payer checks no settlement can change: owner, data length, flags, the trivial "lamports >= 0". */
const safeOnFeePayer = (fp: Address): Instruction[] => [
  on(REAL.ownerSystemNoData, fp),
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
  const [treasuryToken] = await findAssociatedTokenPda({ mint: USDC, owner: payTo.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const transfer = getTransferCheckedInstruction({ source: buyerToken, mint: USDC, destination: treasuryToken, authority: buyer, amount: 2_600n, decimals: 6 });
  const a = around({ buyer: buyer.address, buyerToken, feePayer: feePayer.address, treasuryToken });
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

/** Phantom's guards on a sponsored data request, byte for byte (4ft9Mzwp9d, 20 Nov). */
const phantomDataRequest = ({ buyerToken, feePayer, treasuryToken }: Who): Around => ({
  before: [on(REAL.tokenNoDelegate, treasuryToken), on(REAL.ownerSystemNoData, feePayer), on(REAL.buyerUsdcBefore, buyerToken)],
  after: [on(REAL.tokenNoDelegate, buyerToken)],
});
const OFF_LIMITS = "invalid_exact_svm_payload_invalid_lighthouse_instruction";

describe("a data request signed in Phantom (exact)", () => {
  it("passes exactly as Phantom sent it on 20 Nov: checks on our treasury, the fee payer and the buyer", async () => {
    const { verify, buyer } = await dataRequest(phantomDataRequest);
    await expect(verify()).resolves.toMatchObject({ isValid: true, payer: buyer });
  });

  it("passes with Phantom's data-size limit after its guards", async () => {
    const { verify } = await dataRequest((who) => ({ ...phantomDataRequest(who), before: [...phantomDataRequest(who).before!, dataLimit] }));
    await expect(verify()).resolves.toMatchObject({ isValid: true });
  });

  it("still passes as Solflare sends it: memo, then checks on the buyer's wallet and USDC (an amount check included)", async () => {
    const { verify } = await dataRequest(({ buyer, buyerToken }) => ({ after: [on(REAL.solflareBuyer, buyer), on(REAL.solflareBuyerUsdc, buyerToken)] }));
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

  it("lets our treasury be read only by checks no settlement can change, never its balance", async () => {
    const safe = (t: Address) => [on(REAL.tokenNoDelegate, t), on(infoMulti(ownerIsToken, tokenAccountLength), t), on(tokenMulti([0, ...new Array(32).fill(7), 0], [4, 1, 0]), t)];
    const unsafe = (t: Address) => [
      on(tokenMulti(tokenAmount(5, 1_000_000n)), t), // amount <= what it holds now
      on(tokenMulti([3, 0, 0], tokenAmount(4, 0n)), t), // even a harmless-looking amount check
      on(Uint8Array.from([9, 4, ...tokenAmount(0, 5n)]), t), // AssertTokenAccount, one amount check
      on(infoMulti(lamports(0, 2_039_280n)), t), // lamports == rent (anyone can send it lamports)
      guard(2, 26, [t]), // raw data, which holds the amount
      on(tokenMulti([9]), t), // an unknown token check
    ];
    for (let i = 0; i < safe(LIGHTHOUSE).length; i++) {
      const { verify } = await dataRequest(({ treasuryToken }) => ({ before: [safe(treasuryToken)[i]!] }));
      await expect(verify(), `safe #${i}`).resolves.toMatchObject({ isValid: true });
    }
    for (let i = 0; i < unsafe(LIGHTHOUSE).length; i++) {
      const { verify } = await dataRequest(({ treasuryToken }) => ({ after: [unsafe(treasuryToken)[i]!] }));
      await expect(verify(), `unsafe #${i}`).resolves.toMatchObject({ isValid: false, invalidReason: OFF_LIMITS });
    }
  });

  it("refuses checks on any other account: the USDC mint, a sysvar, someone else's account", async () => {
    const other = (await generateKeyPairSigner()).address;
    for (const target of [USDC, CLOCK, other]) {
      const { verify } = await dataRequest(() => ({ before: [on(REAL.noLamports, target)] }));
      await expect(verify(), target).resolves.toMatchObject({ isValid: false, invalidReason: OFF_LIMITS });
    }
  });

  it("refuses Lighthouse kinds that are not account, mint or token assertions (memory, delta, clock, unknown)", async () => {
    for (const kind of [0, 1, 4, 15, 18]) {
      const { verify } = await dataRequest(() => ({ after: [guard(kind, 26)] }));
      await expect(verify()).resolves.toMatchObject({ isValid: false, invalidReason: OFF_LIMITS });
    }
  });

  it("refuses more than 10 guards, a second data-size limit, and a guard before the compute budget", async () => {
    const eleven = await dataRequest(({ buyer }) => ({ before: Array.from({ length: 6 }, () => on(REAL.noLamports, buyer)), after: Array.from({ length: 5 }, () => on(REAL.noLamports, buyer)) }));
    const twoLimits = await dataRequest(({ buyer }) => ({ before: [dataLimit, on(REAL.noLamports, buyer), dataLimit] }));
    const tooEarly = await dataRequest(({ buyer }) => ({ first: [on(REAL.noLamports, buyer)] }));
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
type Parts = { budget: Instruction[]; open: Instruction; memo: Instruction[]; channel: Address; channelToken: Address; authorizer: Address } & Who;

/** A question's channel open, rebuilt with its instructions laid out by `layout` and signed again by the buyer. */
async function questionDeposit(layout: (parts: Parts) => Instruction[]) {
  const [feePayer, buyer, authorizer, treasury] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const [buyerToken] = await findAssociatedTokenPda({ mint: USDC, owner: buyer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [treasuryToken] = await findAssociatedTokenPda({ mint: USDC, owner: treasury.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const built = await buildOpenPaymentChannelTransaction({
    payer: buyer, payee: feePayer.address, mint: USDC, authorizedSigner: authorizer.address, feePayer: feePayer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS, deposit: DEPOSIT, gracePeriod: GRACE, openSlot: OPEN_SLOT, blockhash: BLOCKHASH,
    computeUnitLimit: 200_000, computeUnitPriceMicroLamports: 1,
  });
  const wire = await reshape(built.transaction, buyer, (parts) =>
    layout({ ...parts, buyer: buyer.address, buyerToken, feePayer: feePayer.address, treasuryToken, authorizer: authorizer.address }),
  );
  const verify = () => verifyOpenTransaction(wire, {
    authorizedSigner: authorizer.address, feePayer: feePayer.address, from: buyer.address, maxCap: DEPOSIT, mint: USDC,
    openSlot: OPEN_SLOT, payee: feePayer.address, recentSlot: OPEN_SLOT, recipients: [], tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: GRACE, ...UPTO_OPEN_LIMITS,
  });
  return { verify, channelId: built.channelId };
}

async function reshape(wire: string, buyer: KeyPairSigner, layout: (parts: Pick<Parts, "budget" | "open" | "memo" | "channel" | "channelToken">) => Instruction[]) {
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
      on(REAL.noLamports, buyer), on(REAL.ownerSystemNoData, feePayer), on(REAL.openBuyerUsdcBefore, buyerToken),
      on(REAL.noLamports, channelToken), on(REAL.noLamports, channel),
      open, ...memo,
      on(REAL.ownerSystemNoData, buyer), on(REAL.tokenNoDelegate, buyerToken),
    ]);
    await expect(verify()).resolves.toMatchObject({ channelId });
  });

  // About a second alone; builds and checks many transactions, so give it room on a loaded run.
  it("lets the fee payer be read only by checks no other settlement can break, before or after the open", { timeout: 20_000 }, async () => {
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

  it("refuses checks on any account but the buyer's, the channel's and the fee payer: the mint, the authorizer, a treasury, a sysvar", async () => {
    for (const pick of [() => USDC, (p: Parts) => p.authorizer, (p: Parts) => p.treasuryToken, () => CLOCK]) {
      for (const where of ["before", "after"] as const) {
        const bad = await questionDeposit((parts) => {
          const g = on(REAL.noLamports, pick(parts));
          return where === "before" ? [...parts.budget, g, parts.open, ...parts.memo] : [...parts.budget, parts.open, ...parts.memo, g];
        });
        await expect(bad.verify(), where).rejects.toThrow(/may check only the buyer's accounts, the channel being opened, or stable facts about the fee payer/);
      }
    }
  });

  it("passes with a data-size limit after the guards or among the compute-budget instructions", async () => {
    const after = await questionDeposit(({ budget, open, memo, buyer }) => [...budget, on(REAL.noLamports, buyer), dataLimit, open, ...memo]);
    const among = await questionDeposit(({ budget, open, memo, buyer }) => [...budget, dataLimit, on(REAL.noLamports, buyer), open, ...memo]);
    await expect(after.verify()).resolves.toMatchObject({ channelId: after.channelId });
    await expect(among.verify()).resolves.toMatchObject({ channelId: among.channelId });
  });

  it("still passes as Phantom sent it before November and Solflare does: memo, then checks on the buyer", async () => {
    const { verify, channelId } = await questionDeposit(({ budget, open, memo, buyer, buyerToken }) => [...budget, open, ...memo, on(REAL.solflareBuyer, buyer), on(REAL.solflareBuyerUsdc, buyerToken)]);
    await expect(verify()).resolves.toMatchObject({ channelId });
  });

  it("refuses Lighthouse kinds that are not account, mint or token assertions, before or after the open", async () => {
    const before = await questionDeposit(({ budget, open, memo }) => [...budget, guard(15, 12), open, ...memo]);
    const after = await questionDeposit(({ budget, open, memo }) => [...budget, open, ...memo, guard(0, 26)]);
    await expect(before.verify()).rejects.toThrow(/must be an account, mint or token assertion/);
    await expect(after.verify()).rejects.toThrow(/must be an account, mint or token assertion/);
  });

  it("refuses more than 10 guards in all", async () => {
    const { verify } = await questionDeposit(({ budget, open, memo, buyer }) => [
      ...budget, ...Array.from({ length: 8 }, () => on(REAL.noLamports, buyer)), open, ...memo, ...Array.from({ length: 3 }, () => on(REAL.noLamports, buyer)),
    ]);
    await expect(verify()).rejects.toThrow(/at most 10 Lighthouse instructions/);
  });

  it("refuses a second data-size limit", async () => {
    const { verify } = await questionDeposit(({ budget, open, memo, buyer }) => [...budget, dataLimit, on(REAL.noLamports, buyer), dataLimit, open, ...memo]);
    await expect(verify()).rejects.toThrow(/expected payment-channels open after the ComputeBudget prefix/);
  });

  it("still refuses anything else before the open", async () => {
    const { verify } = await questionDeposit(({ budget, open, memo }) => [...budget, ...memo, open]);
    await expect(verify()).rejects.toThrow(/expected payment-channels open after the ComputeBudget prefix/);
  });
});
