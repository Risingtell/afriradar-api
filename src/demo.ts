// "Try it without a wallet": the API pays one of its own paid routes with a funded devnet demo
// wallet, through the normal x402 flow, and returns what the buyer would have seen plus the
// on-chain receipts. Same code path as a real buyer; only the signer is the server's.
import type { Hono } from "hono";
import type { TransactionSigner } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import type { Db } from "./db.js";
import { bump, dayOf, hourOf } from "./limits.js";

export const DEMO_LIMITS = { perIpPerHour: 12, perDay: 400 };

const PRODUCTS: Record<string, (p: Record<string, string>) => string> = {
  top: (p) => `/v1/top/${p.category ?? "money-market"}?by=${p.by ?? "yield_ytd"}&limit=${Math.min(Number(p.limit) || 5, 20)}`,
  category: (p) => `/v1/categories/${p.category ?? "money-market"}`,
  fund: (p) => `/v1/funds/${p.id ?? "money-market/aiico-money-market-fund"}`,
  history: (p) => `/v1/funds/${p.id ?? "money-market/aiico-money-market-fund"}/history`,
  compare: (p) => `/v1/compare?ids=${p.ids ?? "money-market/aiico-money-market-fund,money-market/first-ally-money-market-fund"}`,
  kenya: () => "/v1/kenya/unit-trusts",
  kenyaScheme: (p) => `/v1/kenya/unit-trusts/${/^[a-z0-9-]+$/.test(p.id ?? "") ? p.id : "sanlam"}`,
};

/** Counts a demo run against the per-IP hourly and global daily limits. */
async function allow(db: Db, ip: string, now: Date): Promise<string | null> {
  if ((await bump(db, "demo", `ip:${ip}:${hourOf(now)}`, now)) > DEMO_LIMITS.perIpPerHour) return `demo limit is ${DEMO_LIMITS.perIpPerHour} runs an hour per visitor; use your own wallet or try later`;
  if ((await bump(db, "demo", `day:${dayOf(now)}`, now)) > DEMO_LIMITS.perDay) return "today's demo budget is used up; pay with your own devnet wallet instead";
  return null;
}

/** A fetch that pays this same app's paid routes in-process with `signer`, through the normal x402 client. */
export function localPaidFetch(app: Hono, signer: TransactionSigner, rpcUrl: string): typeof fetch {
  const local = ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
  return wrapFetchWithPayment(
    local,
    new x402Client()
      .register("solana:*", new ExactSvmScheme(signer, { rpcUrl }))
      .register("solana:*", new UptoSvmScheme(signer, { rpcUrl }))
      .setSpendControls({ maxAmountPerPayment: "$0.05" }),
  );
}

export function mountDemo(app: Hono, opts: { db: Db; signer: TransactionSigner; rpcUrl: string; explorer: (sig: string) => string; now: () => Date }) {
  // In-process: the demo's paid request goes straight into this same app, no network hop.
  const paidFetch = localPaidFetch(app, opts.signer, opts.rpcUrl);

  app.get("/demo", (c) => c.json({ wallet: opts.signer.address, limits: DEMO_LIMITS, products: Object.keys(PRODUCTS).concat("ask") }));

  app.post("/demo/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { product?: string; question?: string; params?: Record<string, string> };
    const product = String(body.product ?? "");
    if (product !== "ask" && !PRODUCTS[product]) return c.json({ error: `product must be one of ${Object.keys(PRODUCTS).join(", ")}, ask` }, 400);
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    const refused = await allow(opts.db, ip, opts.now());
    if (refused) return c.json({ error: refused }, 429);

    const path = product === "ask" ? "/v1/ask" : PRODUCTS[product](body.params ?? {});
    const started = Date.now();
    const res = await paidFetch(
      `https://api.afriradar.com${path}`,
      product === "ask" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: String(body.question ?? "") }) } : undefined,
    );
    const header = res.headers.get("PAYMENT-RESPONSE");
    const receipt = header ? decodePaymentResponseHeader(header) : null;
    const data = await res.json().catch(() => null);
    return c.json(
      {
        request: `${product === "ask" ? "POST" : "GET"} ${path}`,
        status: res.status,
        data,
        receipt: receipt && { ...receipt, explorer: receipt.transaction ? opts.explorer(receipt.transaction) : null },
        payer: opts.signer.address,
        ms: Date.now() - started,
      },
      res.status === 402 ? 502 : (res.status as 200),
    );
  });
}
