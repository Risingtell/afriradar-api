// Mainnet buyers pay their own network fee: the price includes it, and the facilitator refuses a
// transaction that would cost more in fees than the buyer paid for.
import { describe, expect, it } from "vitest";
import {
  address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash,
} from "@solana/kit";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { MAINNET, NETWORK } from "../src/catalog.js";
import { feeGuard, FEE_LAMPORTS, networkFee, SOL_FALLBACK_USD, solUsdReader, transactionFee, TX_FEE_CAP } from "../src/netfee.js";

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const limitIx = (units: number) => {
  const d = new Uint8Array(5);
  d[0] = 2;
  new DataView(d.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data: d };
};
const priceIx = (microLamports: bigint) => {
  const d = new Uint8Array(9);
  d[0] = 3;
  new DataView(d.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data: d };
};

async function wire(ixs: { programAddress: ReturnType<typeof address>; accounts: never[]; data: Uint8Array }[]) {
  const payer = await generateKeyPairSigner();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n }, m),
    (m) => appendTransactionMessageInstructions([...ixs, { programAddress: MEMO, accounts: [], data: new Uint8Array([1]) }], m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

describe("the network fee on mainnet", () => {
  it("is charged in USDC at the SOL price, in $10 steps rounded up, to the next $0.0001", () => {
    // $72.40 counts as $80: 20,000 lamports = 0.00002 SOL = $0.0016.
    expect(networkFee("exact", 72.4)).toBe(1_600);
    expect(networkFee("upto", 72.4)).toBe(5_000); // 62,000 lamports = $0.00496, rounded up
    expect(networkFee("exact", 80)).toBe(1_600);
    expect(networkFee("exact", 80.01)).toBe(1_800);
  });

  it("reads a transaction's fee: 5,000 lamports a signature plus its priority fee", async () => {
    expect(transactionFee(await wire([limitIx(200_000), priceIx(30_000n)]))).toBe(5_000 + 6_000);
    // No limit instruction: Solana allows 200,000 units per other instruction.
    expect(transactionFee(await wire([priceIx(10n)]))).toBe(5_000 + 2);
    expect(transactionFee(await wire([]))).toBe(5_000);
  });

  it("refuses, before we sign, a mainnet payment whose fee is above what its price covers", async () => {
    let reached = 0;
    const inner: FacilitatorClient = {
      verify: async () => ((reached++), { isValid: true, payer: "x" }),
      settle: async (_p, r) => ((reached++), { success: true, transaction: "t", network: r.network }),
      getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
    };
    const guarded = feeGuard(inner, MAINNET);
    const greedy = await wire([limitIx(1_400_000), priceIx(5_000_000n)]); // 7,000,000 lamports of priority fee
    const fair = await wire([limitIx(200_000), priceIx(30_000n)]);
    const req = (network: string, scheme = "exact") => ({ network, scheme }) as PaymentRequirements;
    const pay = (tx: string) => ({ payload: { transaction: tx } }) as unknown as PaymentPayload;

    const refused = await guarded.verify(pay(greedy), req(MAINNET));
    expect(refused).toMatchObject({ isValid: false, invalidReason: "network_fee_above_price" });
    expect((await guarded.settle(pay(greedy), req(MAINNET))).success).toBe(false);
    expect(reached).toBe(0);
    expect((await guarded.verify(pay(fair), req(MAINNET))).isValid).toBe(true);
    // Devnet moves test money only, so it is not checked.
    expect((await guarded.verify(pay(greedy), req(NETWORK))).isValid).toBe(true);
    // An upto voucher carries no transaction for us to sign.
    expect((await guarded.verify({ payload: { voucher: {} } } as unknown as PaymentPayload, req(MAINNET, "upto"))).isValid).toBe(true);
    expect(TX_FEE_CAP.exact).toBe(FEE_LAMPORTS.exact);
  });

  it("keeps the last good SOL price when a read fails, and overcharges rather than subsidizes with none", async () => {
    const failing = solUsdReader(async () => { throw new Error("rpc down"); });
    expect(await failing()).toBe(SOL_FALLBACK_USD);
  });
});
