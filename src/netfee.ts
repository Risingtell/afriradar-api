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

/**
 * Wraps the facilitator so a mainnet payment is refused before we sign anything if its
 * transaction would cost more in network fees than the buyer was charged for.
 */
export function feeGuard(inner: FacilitatorClient, mainnet: string): FacilitatorClient {
  const check = (payload: PaymentPayload, req: PaymentRequirements): string | null => {
    if (req.network !== mainnet) return null;
    // exact carries `transaction`; an upto deposit carries the channel open as `openTransaction`.
    const p = (payload.payload ?? {}) as { transaction?: unknown; openTransaction?: unknown };
    const tx = p.transaction ?? p.openTransaction;
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
  return {
    verify: async (p, r) => {
      const why = check(p, r);
      return why ? { isValid: false, invalidReason: "network_fee_above_price", invalidMessage: why, payer: "" } as Awaited<ReturnType<FacilitatorClient["verify"]>> : inner.verify(p, r);
    },
    settle: async (p, r) => {
      const why = check(p, r);
      if (why) return { success: false, errorReason: "network_fee_above_price", errorMessage: why, transaction: "", network: r.network, payer: "" } as Awaited<ReturnType<FacilitatorClient["settle"]>>;
      return inner.settle(p, r);
    },
    getSupported: () => inner.getSupported(),
  };
}
