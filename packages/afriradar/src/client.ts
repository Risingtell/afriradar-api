// The AfriRadar Data API client. Every paid method pays its own x402 invoice in USDC on Solana
// and returns the data together with the on-chain receipt.
import type { TransactionSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";

export const DEFAULT_BASE_URL = "https://api.afriradar.com";
export const DEVNET_RPC = "https://api.devnet.solana.com";

export type Category = "money-market" | "bond" | "dollar" | "equity" | "balanced" | "shariah" | "reit" | "ethical" | "specialised";
export type RankBy = "yield_ytd" | "yield_wtd" | "nav" | "unitholders";

export type Receipt = {
  transaction: string;
  /** micro-USDC actually settled (6 decimals). */
  amount: number;
  usdc: number;
  payer?: string;
  explorer: string;
};
export type Paid<T> = { data: T; receipt: Receipt };

export class AfriRadarError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

export type AfriRadarOptions = {
  /** Pays for data. Any @solana/kit TransactionSigner works: a KeyPairSigner, or a wallet adapter. Free calls need none. */
  signer?: TransactionSigner;
  baseUrl?: string;
  /** Used to build payment transactions. Defaults to the public devnet RPC. */
  rpcUrl?: string;
  /** Refuse any single payment above this (USDC). Default 0.05, the /v1/ask ceiling. */
  maxPerRequest?: number;
  /** Refuse payments once this much (USDC) has been spent by this client. Default: no limit. */
  budget?: number;
  fetch?: typeof fetch;
};

const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export function createAfriRadar(opts: AfriRadarOptions) {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const rpcUrl = opts.rpcUrl ?? DEVNET_RPC;
  const maxPer = Math.round((opts.maxPerRequest ?? 0.05) * 1e6);
  const budget = opts.budget === undefined ? Infinity : Math.round(opts.budget * 1e6);
  let spent = 0;

  const signer = opts.signer;
  const raw = opts.fetch ?? fetch;
  // The price each request agreed to pay, by resource URL. Exact-scheme receipts carry no amount,
  // so this is where the client learns what it actually paid.
  const agreed = new Map<string, number>();
  const paidFetch = signer ? wrapFetchWithPayment(raw, new x402Client()
    .register("solana:*", new ExactSvmScheme(signer, { rpcUrl }))
    .register("solana:*", new UptoSvmScheme(signer, { rpcUrl }))
    .setSpendControls({ maxAmountPerPayment: `$${maxPer / 1e6}` })
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const amount = Number(selectedRequirements.amount);
      if (amount > maxPer) return { abort: true, reason: `price ${amount / 1e6} USDC is above maxPerRequest ${maxPer / 1e6}` };
      if (spent + amount > budget) return { abort: true, reason: `budget: ${(budget - spent) / 1e6} USDC left, this needs up to ${amount / 1e6}` };
    })
    .onAfterPaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      agreed.set(paymentRequired.resource?.url ?? "", Number(selectedRequirements.amount));
    })) : null;

  async function free<T>(path: string): Promise<T> {
    const res = await raw(`${base}${path}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new AfriRadarError((body as { error?: string })?.error ?? `HTTP ${res.status}`, res.status, body);
    return body as T;
  }

  async function paid<T>(path: string, init?: RequestInit): Promise<Paid<T>> {
    if (!paidFetch) throw new AfriRadarError("this call is paid: pass a signer to createAfriRadar", 402);
    const res = await paidFetch(`${base}${path}`, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new AfriRadarError((body as { error?: string })?.error ?? `HTTP ${res.status}`, res.status, body);
    const header = res.headers.get("PAYMENT-RESPONSE");
    const settled = header ? decodePaymentResponseHeader(header) : null;
    if (!settled?.success || !settled.transaction) throw new AfriRadarError("server returned data without a settlement receipt", res.status, body);
    const amount = Number(settled.amount ?? agreed.get(`${base}${path}`) ?? 0);
    spent += amount;
    return { data: body as T, receipt: { transaction: settled.transaction, amount, usdc: amount / 1e6, payer: settled.payer, explorer: explorerTx(settled.transaction) } };
  }

  const enc = encodeURIComponent;
  const fundPath = (id: string) => {
    const [category, slug] = id.split("/");
    if (!category || !slug) throw new AfriRadarError(`fund id must look like category/slug, got "${id}"`, 400);
    return `/v1/funds/${enc(category)}/${enc(slug)}`;
  };

  return {
    /** USDC spent by this client so far. */
    get spent() {
      return spent / 1e6;
    },
    // free
    catalog: () => free<Record<string, unknown>>("/v1"),
    overview: () => free<Record<string, unknown>>("/v1/overview"),
    search: (q: string, limit = 10) => free<{ results: { id: string; name: string; manager: string; category: Category }[] }>(`/v1/search?q=${enc(q)}&limit=${limit}`),
    payments: (limit = 50) => free<Record<string, unknown>>(`/v1/payments?limit=${limit}`),
    // paid
    category: (c: Category) => paid<Record<string, unknown>>(`/v1/categories/${enc(c)}`),
    fund: (id: string) => paid<Record<string, unknown>>(fundPath(id)),
    history: (id: string) => paid<Record<string, unknown>>(`${fundPath(id)}/history`),
    top: (c: Category, o: { by?: RankBy; limit?: number } = {}) => paid<Record<string, unknown>>(`/v1/top/${enc(c)}?by=${o.by ?? "yield_ytd"}&limit=${o.limit ?? 10}`),
    compare: (ids: string[]) => paid<Record<string, unknown>>(`/v1/compare?ids=${ids.map(enc).join(",")}`),
    /** Metered: authorizes up to $0.05 on chain, settles only the itemized bill. */
    ask: (question: string) =>
      paid<{ answer: string; week: string; bill: { total: number; data: { tool: string; price: number }[]; tokens: { prompt: number; completion: number; price: number } } }>("/v1/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      }),
  };
}

export type AfriRadar = ReturnType<typeof createAfriRadar>;
