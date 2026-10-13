// The AfriRadar Data API as a Hono app. Runtime-neutral: the Worker wires D1, Workers AI and
// secrets into it; tests wire sqlite and fakes. Payments are x402 on Solana, settled by our own
// facilitator, and every settlement is written to a public ledger anyone can check on chain.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/hono";
import { ExactSvmScheme as ExactServer } from "@x402/svm/exact/server";
import { UptoSvmScheme as UptoServer } from "@x402/svm/upto/server";
import type { MessagePartialSigner } from "@solana/kit";
import { ask, AskError, type Llm } from "./agent/ask.js";
import { NETWORK, PRODUCTS, USDC_DEVNET, usd, type ProductId } from "./catalog.js";
import type { Db } from "./db.js";
import { CATEGORIES, isCategory } from "./data/model.js";
import * as q from "./data/queries.js";
import { readPayment, type ChainPayment } from "./reconcile.js";

export type Deps = {
  db: Db;
  facilitator: FacilitatorClient;
  llm: Llm;
  treasury: string;
  authorizer: MessagePartialSigner;
  rpcUrl: string;
  /** Looks a settlement up on chain. Injected so tests never touch the network. */
  readChain: (signature: string) => Promise<ChainPayment>;
  explorer?: (sig: string) => string;
  now?: () => Date;
};

const explorerDefault = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const pathOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).pathname + new URL(url).search : "";
  } catch {
    return url ?? "";
  }
};

export async function createApp(deps: Deps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const explorer = deps.explorer ?? explorerDefault;

  const record = (row: { id: string; tx: string | null; route: string; scheme: string; amount: string; ceiling?: string | null; payer?: string | null; status: string; detail?: string | null }) =>
    db.run(
      `INSERT INTO payments (id, tx, route, scheme, amount, ceiling, payer, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, amount = excluded.amount, detail = excluded.detail`,
      row.id, row.tx, row.route, row.scheme, row.amount, row.ceiling ?? null, row.payer ?? null, row.status, row.detail ?? null, now().toISOString(),
    );

  const resourceServer = new x402ResourceServer(deps.facilitator)
    .register(NETWORK as Network, new ExactServer())
    .register(NETWORK as Network, new UptoServer({ receiverAuthorizerSigner: deps.authorizer, rpcUrl: deps.rpcUrl }))
    .onAfterSettle(async (ctx) => {
      const r = ctx.result;
      const status = ctx.phase === "before-handler" ? "deposit" : ctx.phase === "cancel" ? "refunded" : "settled";
      await record({
        id: `${r.transaction}:${status}`,
        tx: r.transaction || null,
        route: pathOf(ctx.paymentPayload.resource?.url),
        scheme: ctx.requirements.scheme,
        amount: status === "deposit" ? String(ctx.requirements.amount) : status === "refunded" ? "0" : (r.amount ?? String(ctx.requirements.amount)),
        ceiling: ctx.requirements.scheme === "upto" ? String(ctx.requirements.amount) : null,
        payer: r.payer ?? null,
        status,
      });
    })
    // A "settlement_pending" answer means the transaction was broadcast but its confirmation was
    // not seen (often an RPC rate limit). The buyer may already have paid, so read the chain
    // before withholding what they bought. Recovered only when the treasury really received it.
    .onSettleFailure(async (ctx) => {
      const err = ctx.error as Error & { errorReason?: string; transaction?: string; payer?: string };
      const tx = err.transaction;
      const route = pathOf(ctx.paymentPayload.resource?.url);
      if (err.errorReason !== "settlement_pending" || !tx) {
        await record({ id: `${tx || crypto.randomUUID()}:failed`, tx: tx || null, route, scheme: ctx.requirements.scheme, amount: "0", payer: err.payer, status: "failed", detail: err.errorReason ?? err.message });
        return;
      }
      const chain = await deps.readChain(tx);
      const expected = BigInt(ctx.requirements.scheme === "upto" ? 1 : ctx.requirements.amount);
      if (chain.status === "confirmed" && chain.received >= expected) {
        await record({ id: `${tx}:settled`, tx, route, scheme: ctx.requirements.scheme, amount: chain.received.toString(), payer: err.payer, status: "settled", detail: "recovered from chain after settlement_pending" });
        return {
          recovered: true as const,
          result: { success: true, transaction: tx, network: ctx.requirements.network, payer: err.payer, amount: chain.received.toString() },
        };
      }
      await record({ id: `${tx}:pending`, tx, route, scheme: ctx.requirements.scheme, amount: "0", payer: err.payer, status: "pending", detail: `chain says ${chain.status}; redeem at /v1/redeem/${tx}` });
    });
  await resourceServer.initialize();

  const routes: RoutesConfig = Object.fromEntries(
    (Object.entries(PRODUCTS) as [ProductId, (typeof PRODUCTS)[ProductId]][]).map(([, p]) => [
      `${p.method} ${p.path}`,
      { accepts: { scheme: p.scheme, price: usd(p.price), network: NETWORK as Network, payTo: deps.treasury }, description: p.summary, mimeType: "application/json" },
    ]),
  );

  const app = new Hono();
  app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"], allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"] }));
  app.onError((e, c) => {
    if (e instanceof AskError) return c.json({ error: e.message }, e.status);
    console.error(e);
    return c.json({ error: "internal error, you were not charged" }, 500);
  });

  // ---------- free ----------
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1", async (c) => {
    const week = await q.latestWeek(db);
    return c.json({
      name: "AfriRadar Data API",
      about: "SEC Nigeria weekly NAV data for every collective investment scheme, sold per request over x402 on Solana.",
      network: NETWORK,
      asset: { symbol: "USDC", mint: USDC_DEVNET, decimals: 6 },
      payTo: deps.treasury,
      dataWeek: week,
      categories: Object.entries(CATEGORIES).map(([id, m]) => ({ id, name: m.name })),
      free: ["GET /v1", "GET /v1/overview", "GET /v1/search?q=", "GET /v1/payments", "GET /v1/redeem/:tx"],
      products: Object.entries(PRODUCTS).map(([id, p]) => ({ id, method: p.method, path: p.path, scheme: p.scheme, price: usd(p.price), priceMicroUsdc: p.price, summary: p.summary, example: p.example })),
      failedPayments: "A request that errors is never charged. If a settlement is broadcast but unconfirmed, the server checks the chain before replying; anything still unresolved can be redeemed at /v1/redeem/:tx.",
    });
  });
  app.get("/v1/overview", async (c) => c.json(await q.overview(db)));
  app.get("/v1/search", async (c) => c.json({ results: await q.search(db, c.req.query("q") ?? "", Number(c.req.query("limit")) || 10) }));
  app.get("/v1/payments", async (c) => {
    const rows = await db.all<Record<string, string>>("SELECT tx, route, scheme, amount, ceiling, payer, status, detail, created_at FROM payments ORDER BY created_at DESC LIMIT ?", Math.min(Number(c.req.query("limit")) || 50, 200));
    const totals = await db.first<{ n: number; micro: number; payers: number }>("SELECT count(*) AS n, coalesce(sum(CAST(amount AS INTEGER)), 0) AS micro, count(DISTINCT payer) AS payers FROM payments WHERE status = 'settled'");
    return c.json({
      settled: { payments: totals?.n ?? 0, usdc: (totals?.micro ?? 0) / 1e6, payers: totals?.payers ?? 0 },
      recent: rows.map((r) => ({ ...r, usdc: Number(r.amount) / 1e6, explorer: r.tx ? explorer(r.tx) : null })),
      verify: "Every tx above is a Solana devnet transaction. Run `npx afriradar verify` to recount them from the chain.",
    });
  });
  // Paid but unconfirmed at reply time? Once the chain shows the money arrived, the data is released free.
  app.get("/v1/redeem/:tx", async (c) => {
    const tx = c.req.param("tx");
    const row = await db.first<{ route: string; scheme: string; status: string }>("SELECT route, scheme, status FROM payments WHERE tx = ? ORDER BY created_at DESC", tx);
    if (!row) return c.json({ error: "no payment with that transaction" }, 404);
    if (row.scheme !== "exact" || !row.route.startsWith("/v1/")) return c.json({ error: "only data products can be redeemed; a metered /v1/ask is never charged unless it was answered" }, 400);
    const chain = await deps.readChain(tx);
    if (chain.status !== "confirmed" || chain.received <= 0n) return c.json({ status: chain.status, message: "not confirmed on chain yet, try again shortly" }, 409);
    await record({ id: `${tx}:settled`, tx, route: row.route, scheme: row.scheme, amount: chain.received.toString(), status: "settled", detail: "redeemed" });
    return serveData(c, new URL(row.route, "https://x").pathname, new URL(row.route, "https://x").searchParams);
  });

  // ---------- paid ----------
  app.use(paymentMiddleware(routes, resourceServer));

  async function serveData(c: Context, path: string, params: URLSearchParams): Promise<Response> {
    const parts = path.split("/").filter(Boolean); // v1, ...
    const notFound = (what: string) => c.json({ error: `${what} not found, you were not charged` }, 404);
    if (parts[1] === "categories" && parts.length === 3) {
      if (!isCategory(parts[2])) return notFound("category");
      return c.json(await q.category(db, parts[2]));
    }
    if (parts[1] === "funds" && (parts.length === 4 || (parts.length === 5 && parts[4] === "history"))) {
      const id = `${parts[2]}/${parts[3]}`;
      const data = parts.length === 5 ? await q.history(db, id) : await q.fund(db, id);
      return data ? c.json(data) : notFound("fund");
    }
    if (parts[1] === "top" && parts.length === 3) {
      if (!isCategory(parts[2])) return notFound("category");
      const by = (params.get("by") ?? "yield_ytd") as q.RankBy;
      if (!(by in q.RANK_BY)) return c.json({ error: "by must be yield_ytd, yield_wtd, nav or unitholders; you were not charged" }, 400);
      return c.json(await q.top(db, parts[2], by, Number(params.get("limit")) || 10));
    }
    if (parts[1] === "compare" && parts.length === 2) {
      const ids = (params.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!ids.length || ids.length > 5) return c.json({ error: "ids must list 1 to 5 fund ids; you were not charged" }, 400);
      return c.json(await q.compare(db, ids));
    }
    return notFound("product");
  }

  for (const id of ["category", "fund", "history", "top", "compare"] as const) {
    app.get(PRODUCTS[id].path, (c) => serveData(c, new URL(c.req.url).pathname, new URL(c.req.url).searchParams));
  }

  app.post(PRODUCTS.ask.path, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
    const result = await ask(db, deps.llm, String(body.question ?? ""), { ceiling: PRODUCTS.ask.price });
    setSettlementOverrides(c, { amount: String(result.bill.total) });
    return c.json({
      answer: result.answer,
      week: result.week,
      bill: { ...result.bill, totalUsdc: result.bill.total / 1e6, ceilingUsdc: result.bill.ceiling / 1e6 },
      source: "SEC Nigeria weekly valuation reports of collective investment schemes, via afriradar.com",
      note: "Data, not investment advice.",
    });
  });

  return app;
}

/** Default chain reader for production: JSON-RPC against the configured endpoint. */
export const chainReader = (rpc: Parameters<typeof readPayment>[0], treasury: string) => (sig: string) => readPayment(rpc, sig, treasury, USDC_DEVNET);
