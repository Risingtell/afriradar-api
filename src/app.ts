// The AfriRadar Data API as a Hono app. Runtime-neutral: the Worker wires D1, Workers AI and
// secrets into it; tests wire sqlite and fakes. Payments are x402 on Solana, settled by our own
// facilitator, and every settlement is written to a public ledger anyone can check on chain.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/hono";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { ExactSvmScheme as ExactServer } from "@x402/svm/exact/server";
import { UptoSvmScheme as UptoServer } from "@x402/svm/upto/server";
import type { MessagePartialSigner, TransactionSigner } from "@solana/kit";
import { ask, AskError, questionProblem, type Llm } from "./agent/ask.js";
import { CHAINS, chainOf, explorerUrl, MAINNET, NETWORK, PRODUCTS, USDC_DEVNET, usd, type ProductId } from "./catalog.js";
import type { Db } from "./db.js";
import { CATEGORIES, isCategory } from "./data/model.js";
import * as kenya from "./data/kenya.js";
import * as q from "./data/queries.js";
import { mountDemo } from "./demo.js";
import { discoveryExtension, mountDiscovery } from "./discovery.js";
import { mountFaucet } from "./faucet.js";
import { bump, hourOf } from "./limits.js";
import { mcpTools, mountMcp } from "./mcp.js";
import { monitorStatus } from "./monitor.js";
import { capProof } from "./proof.js";
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
  /** Solana mainnet, real USDC. Without it the API sells on devnet only. */
  mainnet?: { rpcUrl: string; readChain: (signature: string) => Promise<ChainPayment> };
  explorer?: (sig: string, network?: string | null) => string;
  now?: () => Date;
  /** Funded devnet wallet behind the no-wallet demo. Its payments are labelled demo in the ledger. */
  demoSigner?: TransactionSigner;
  /** The facilitator's fee payer: pays the network fee and account rent for faucet sends. */
  feePayer?: TransactionSigner;
};

export const MAINNET_ASKS_PER_HOUR = 30;

/** The network a payment header pays on; null when unreadable (the payment middleware then refuses it). */
const paidNetwork = (header: string): string | null => {
  try {
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (ch) => ch.charCodeAt(0)))) as { accepted?: { network?: string }; network?: string };
    return p.accepted?.network ?? p.network ?? null;
  } catch {
    return null;
  }
};

const pathOf = (url: string | undefined) => {
  try {
    if (url && !/^https?:/.test(url)) return url; // mcp://tool/<name> for paid MCP tool calls
    return url ? new URL(url).pathname + new URL(url).search : "";
  } catch {
    return url ?? "";
  }
};

export async function createApp(deps: Deps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const explorer = deps.explorer ?? explorerUrl;
  const mainnet = deps.mainnet;
  const chains = mainnet ? [CHAINS.devnet, CHAINS.mainnet] : [CHAINS.devnet];
  const readChainOn = (network: string | null | undefined) => (network === MAINNET && mainnet ? mainnet.readChain : deps.readChain);

  const record = (row: { id: string; tx: string | null; network: string; route: string; scheme: string; amount: string; ceiling?: string | null; payer?: string | null; status: string; detail?: string | null }) =>
    db.run(
      `INSERT INTO payments (id, tx, network, route, scheme, amount, ceiling, payer, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, amount = excluded.amount, detail = excluded.detail`,
      row.id, row.tx, row.network, row.route, row.scheme, row.amount, row.ceiling ?? null, row.payer ?? null, row.status, row.detail ?? null, now().toISOString(),
    );

  // Settled payments without the hourly monitor's own, plus the share paid by visitors' wallets
  // (anyone but our demo wallet). The monitor is counted on its own line.
  const ledgerTotals = async () => {
    const demo = deps.demoSigner?.address ?? "";
    const t = await db.first<{ n: number; micro: number; payers: number; vn: number; vmicro: number; vpayers: number; mn: number }>(
      `SELECT coalesce(sum(1 - mon), 0) AS n, coalesce(sum(CASE WHEN mon = 0 THEN amt ELSE 0 END), 0) AS micro,
              count(DISTINCT CASE WHEN mon = 0 THEN payer END) AS payers,
              coalesce(sum(CASE WHEN mon = 0 AND payer <> ? THEN 1 ELSE 0 END), 0) AS vn,
              coalesce(sum(CASE WHEN mon = 0 AND payer <> ? THEN amt ELSE 0 END), 0) AS vmicro,
              count(DISTINCT CASE WHEN mon = 0 AND payer <> ? THEN payer END) AS vpayers,
              coalesce(sum(mon), 0) AS mn
       FROM (SELECT payer, CAST(amount AS INTEGER) AS amt, CASE WHEN detail = 'monitor' THEN 1 ELSE 0 END AS mon FROM payments WHERE status = 'settled')`,
      demo, demo, demo,
    );
    // The same settled figures per network. Wallets are counted once overall, so these do not sum to it.
    const per = await db.all<{ network: string; n: number; micro: number; payers: number }>(
      `SELECT network, count(*) AS n, coalesce(sum(CAST(amount AS INTEGER)), 0) AS micro, count(DISTINCT payer) AS payers
       FROM payments WHERE status = 'settled' AND (detail IS NULL OR detail <> 'monitor') GROUP BY network`,
    );
    const networks = Object.fromEntries(
      chains.map((ch) => {
        const r = per.find((x) => x.network === ch.network);
        return [ch.id, { payments: r?.n ?? 0, usdc: (r?.micro ?? 0) / 1e6, payers: r?.payers ?? 0 }];
      }),
    );
    return {
      settled: { payments: t?.n ?? 0, usdc: (t?.micro ?? 0) / 1e6, payers: t?.payers ?? 0 },
      visitors: { payments: t?.vn ?? 0, usdc: (t?.vmicro ?? 0) / 1e6, wallets: t?.vpayers ?? 0 },
      monitor: { payments: t?.mn ?? 0 },
      networks,
    };
  };
  const status = async () => {
    const since = new Date(now().getTime() - 7 * 86_400_000).toISOString();
    const p = await db.first<{ settled: number; failed: number }>("SELECT coalesce(sum(status = 'settled'), 0) AS settled, coalesce(sum(status = 'failed'), 0) AS failed FROM payments WHERE created_at >= ?", since);
    return { ...(await monitorStatus(db, now(), explorer)), payments7d: { settled: p?.settled ?? 0, failed: p?.failed ?? 0 }, ledger: await ledgerTotals() };
  };

  const resourceServer = new x402ResourceServer(deps.facilitator)
    .register(NETWORK as Network, new ExactServer())
    .register(NETWORK as Network, new UptoServer({ receiverAuthorizerSigner: deps.authorizer, rpcUrl: deps.rpcUrl }));
  if (mainnet) {
    resourceServer
      .register(MAINNET as Network, new ExactServer())
      .register(MAINNET as Network, new UptoServer({ receiverAuthorizerSigner: deps.authorizer, rpcUrl: mainnet.rpcUrl }));
  }
  resourceServer
    .onAfterSettle(async (ctx) => {
      const r = ctx.result;
      const status = ctx.phase === "before-handler" ? "deposit" : ctx.phase === "cancel" ? "refunded" : "settled";
      await record({
        id: `${r.transaction}:${status}`,
        tx: r.transaction || null,
        network: ctx.requirements.network,
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
      const network = ctx.requirements.network;
      if (err.errorReason !== "settlement_pending" || !tx) {
        // err.message is "reason: explanation"; the reason code alone does not say what to fix.
        await record({ id: `${tx || crypto.randomUUID()}:failed`, tx: tx || null, network, route, scheme: ctx.requirements.scheme, amount: "0", payer: err.payer, status: "failed", detail: err.message || err.errorReason });
        return;
      }
      const chain = await readChainOn(network)(tx);
      const expected = BigInt(ctx.requirements.scheme === "upto" ? 1 : ctx.requirements.amount);
      if (chain.status === "confirmed" && chain.received >= expected) {
        await record({ id: `${tx}:settled`, tx, network, route, scheme: ctx.requirements.scheme, amount: chain.received.toString(), payer: err.payer, status: "settled", detail: "recovered from chain after settlement_pending" });
        return {
          recovered: true as const,
          result: { success: true, transaction: tx, network: ctx.requirements.network, payer: err.payer, amount: chain.received.toString() },
        };
      }
      await record({ id: `${tx}:pending`, tx, network, route, scheme: ctx.requirements.scheme, amount: "0", payer: err.payer, status: "pending", detail: `chain says ${chain.status}; redeem at /v1/redeem/${tx}` });
    });
  resourceServer.registerExtension(bazaarResourceServerExtension);
  await resourceServer.initialize();

  const routes: RoutesConfig = Object.fromEntries(
    (Object.entries(PRODUCTS) as [ProductId, (typeof PRODUCTS)[ProductId]][]).map(([id, p]) => [
      `${p.method} ${p.path}`,
      {
        // Devnet first: a buyer that accepts any Solana network pays with free test USDC, and only a
        // buyer that asks for mainnet pays real USDC.
        accepts: chains.map((ch) => ({
          scheme: p.scheme,
          price: usd(p.price),
          network: ch.network as Network,
          payTo: deps.treasury,
          // The upto client stamps validAfter with the buyer's own clock unless we send one, and the
          // facilitator refuses a payment whose validAfter is ahead of the server's clock. A phone or
          // PC running even a second fast could never pay for /v1/ask. 0 means "valid now"; the
          // payment still expires, and each channel can only be opened once.
          ...(p.scheme === "upto" ? { extra: { validAfter: 0 } } : {}),
        })),
        description: p.summary,
        mimeType: "application/json",
        extensions: discoveryExtension(id),
      },
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
      about: "African fund data from the regulators, sold per request over x402 on Solana: SEC Nigeria's weekly NAV report for every collective investment scheme, and CMA Kenya's quarterly assets for every unit trust scheme.",
      network: NETWORK,
      asset: { symbol: "USDC", mint: USDC_DEVNET, decimals: 6 },
      payTo: deps.treasury,
      networks: chains.map((ch) => ({ id: ch.id, network: ch.network, label: ch.label, money: ch.money, asset: { symbol: "USDC", mint: ch.usdc, decimals: 6 }, rpcRelay: ch.id === "devnet" ? "/rpc" : `/rpc/${ch.id}` })),
      dataWeek: week,
      markets: [
        { id: "nigeria", source: "SEC Nigeria weekly valuation report", frequency: "weekly", latest: week },
        { id: "kenya", source: "CMA Kenya quarterly statistical bulletin", frequency: "quarterly", latest: await kenya.latestQuarter(db) },
      ],
      categories: Object.entries(CATEGORIES).map(([id, m]) => ({ id, name: m.name })),
      free: ["GET /v1", "GET /v1/overview", "GET /v1/search?q=", "GET /v1/payments", "GET /v1/status", "GET /v1/proof/cap", "GET /v1/redeem/:tx", "GET /discovery/resources", "POST /mcp"],
      mcp: "https://api.afriradar.com/mcp: the same data as MCP tools, paid tools charged over x402 inside MCP.",
      products: Object.entries(PRODUCTS).map(([id, p]) => ({ id, method: p.method, path: p.path, scheme: p.scheme, price: usd(p.price), priceMicroUsdc: p.price, summary: p.summary, example: p.example })),
      failedPayments: "A request that errors is never charged. If a settlement is broadcast but unconfirmed, the server checks the chain before replying; anything still unresolved can be redeemed at /v1/redeem/:tx.",
    });
  });
  app.get("/v1/overview", async (c) => c.json({ ...(await q.overview(db)), kenya: await kenya.kenyaOverview(db) }));
  app.get("/v1/search", async (c) => {
    const text = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit")) || 10;
    return c.json({ results: await q.search(db, text, limit), kenya: await kenya.searchKenya(db, text, limit) });
  });
  // Rows for one network at a time (devnet unless asked), so a recount reads them all from one chain.
  app.get("/v1/payments", async (c) => {
    const want = c.req.query("network") ?? "devnet";
    if (want !== "all" && !chains.some((ch) => ch.id === want)) return c.json({ error: `network must be ${chains.map((ch) => ch.id).join(", ")} or all` }, 400);
    const only = want === "all" ? null : CHAINS[want as keyof typeof CHAINS].network;
    const rows = await db.all<Record<string, string>>(
      `SELECT tx, network, route, scheme, amount, ceiling, payer, status, detail, created_at FROM payments ${only ? "WHERE network = ?" : ""} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      ...(only ? [only] : []), Math.min(Number(c.req.query("limit")) || 50, 200), Math.max(Number(c.req.query("offset")) || 0, 0),
    );
    const t = await ledgerTotals();
    return c.json({
      settled: t.settled,
      visitors: t.visitors,
      monitor: t.monitor,
      networks: t.networks,
      network: want,
      recent: rows.map((r) => ({ ...r, chain: chainOf(r.network).id, usdc: Number(r.amount) / 1e6, monitor: r.detail === "monitor", demo: !!deps.demoSigner && r.payer === deps.demoSigner.address && r.detail !== "monitor", explorer: r.tx ? explorer(r.tx, r.network) : null })),
      demoWallet: deps.demoSigner?.address ?? null,
      verify: `These rows are ${want === "all" ? "Solana devnet and mainnet" : chainOf(only).label} transactions (?network=${chains.map((ch) => ch.id).join("|")}|all). Recount them from the chain in your browser at https://api.afriradar.com/#ledger, or run \`npx afriradar verify\`.`,
    });
  });
  // Paid but unconfirmed at reply time? Once the chain shows the money arrived, the data is released free.
  app.get("/v1/redeem/:tx", async (c) => {
    const tx = c.req.param("tx");
    const row = await db.first<{ network: string; route: string; scheme: string; status: string }>("SELECT network, route, scheme, status FROM payments WHERE tx = ? ORDER BY created_at DESC", tx);
    if (!row) return c.json({ error: "no payment with that transaction" }, 404);
    if (row.scheme !== "exact" || !row.route.startsWith("/v1/")) return c.json({ error: "only data products can be redeemed; a metered /v1/ask is never charged unless it was answered" }, 400);
    const chain = await readChainOn(row.network)(tx);
    if (chain.status !== "confirmed" || chain.received <= 0n) return c.json({ status: chain.status, message: "not confirmed on chain yet, try again shortly" }, 409);
    await record({ id: `${tx}:settled`, tx, network: row.network, route: row.route, scheme: row.scheme, amount: chain.received.toString(), status: "settled", detail: "redeemed" });
    return serveData(c, new URL(row.route, "https://x").pathname, new URL(row.route, "https://x").searchParams);
  });

  app.get("/v1/status", async (c) => c.json(await status()));

  // Solana enforces the analyst's cap: simulate the buyer's real channel-open plus an over-cap claim.
  app.get("/v1/proof/cap", async (c) => {
    if (!deps.demoSigner) return c.json({ error: "the live proof needs the demo wallet, which this deployment does not have" }, 503);
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    if ((await bump(db, "proof", `ip:${ip}:${hourOf(now())}`, now())) > 20) return c.json({ error: "the live proof runs 20 times an hour per visitor; try later" }, 429);
    const challenge = await app.fetch(new Request(`https://api.afriradar.com${PRODUCTS.ask.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "cap proof" }) }));
    const header = challenge.headers.get("PAYMENT-REQUIRED");
    const required = header ? (JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (ch) => ch.charCodeAt(0)))) as PaymentRequired) : null;
    const requirements = required?.accepts.find((a: PaymentRequirements) => a.scheme === "upto" && a.network === NETWORK);
    if (!requirements) return c.json({ error: "could not read this server's own payment challenge" }, 502);
    return c.json(await capProof({ requirements, buyer: deps.demoSigner, authorizer: deps.authorizer, rpcUrl: deps.rpcUrl, explorer, now }));
  });

  // Read-only RPC relay for browser buyers: they need a blockhash and account reads to build a
  // payment, and the public devnet RPC rate-limits browsers hard. Allow-listed reads only, so the
  // relay cannot send transactions or leak the keyed RPC URL.
  // getSignaturesForAddress and getTransaction let a visitor recount the treasury from the chain.
  const RPC_READS = new Set(["getLatestBlockhash", "getAccountInfo", "getMultipleAccounts", "getBalance", "getTokenAccountsByOwner", "getTokenAccountBalance", "getMinimumBalanceForRentExemption", "getSignatureStatuses", "getSlot", "getSignaturesForAddress", "getTransaction"]);
  const relay = (rpcUrl: string) => async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { method?: string } | { method?: string }[] | null;
    const calls = Array.isArray(body) ? body : body ? [body] : [];
    if (!calls.length || calls.length > 25 || calls.some((x) => !RPC_READS.has(String(x?.method)))) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: `relay allows only: ${[...RPC_READS].join(", ")}` } }, 400);
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  };
  app.post("/rpc", relay(deps.rpcUrl));
  if (mainnet) app.post("/rpc/mainnet", relay(mainnet.rpcUrl));

  // A question's deposit goes into a payment channel before the analyst runs, and a refused question
  // is refunded with the facilitator paying both network fees. So a paid request with a bad question
  // is turned away before any channel opens; an unpaid one still gets its 402 price. Mainnet questions
  // are also capped per visitor, because each open channel holds some of the facilitator's SOL as
  // rent until the hourly cleanup returns it.
  app.post(PRODUCTS.ask.path, async (c, next) => {
    const paid = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT");
    if (!paid) return next();
    const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
    const problem = questionProblem(String(body.question ?? ""));
    if (problem) return c.json({ error: `${problem}; you were not charged` }, 400);
    if (paidNetwork(paid) === MAINNET) {
      const ip = c.req.header("cf-connecting-ip") ?? "local";
      if ((await bump(db, "mainnet-ask", `ip:${ip}:${hourOf(now())}`, now())) > MAINNET_ASKS_PER_HOUR) return c.json({ error: `mainnet questions are limited to ${MAINNET_ASKS_PER_HOUR} an hour per visitor; you were not charged` }, 429);
    }
    return next();
  });

  if (deps.demoSigner) mountDemo(app, { db, signer: deps.demoSigner, rpcUrl: deps.rpcUrl, explorer, now });
  if (deps.demoSigner && deps.feePayer) mountFaucet(app, { db, source: deps.demoSigner, feePayer: deps.feePayer, rpcUrl: deps.rpcUrl, explorer, now });
  const networks = chains.map((ch) => ch.network as Network);
  mountMcp(app, { db, resourceServer, treasury: deps.treasury, networks, status });
  mountDiscovery(app, { resourceServer, treasury: deps.treasury, networks, tools: mcpTools(db, { status, networks }), now });

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
    if (parts[1] === "kenya" && parts[2] === "unit-trusts" && parts.length === 3) {
      const data = await kenya.kenyaSchemes(db);
      return data.quarter ? c.json(data) : notFound("Kenya data");
    }
    if (parts[1] === "kenya" && parts[2] === "unit-trusts" && parts.length === 4) {
      const data = await kenya.kenyaScheme(db, parts[3]);
      return data ? c.json(data) : notFound("scheme");
    }
    return notFound("product");
  }

  for (const id of ["category", "fund", "history", "top", "compare", "kenya", "kenyaScheme"] as const) {
    app.get(PRODUCTS[id].path, (c) => serveData(c, new URL(c.req.url).pathname, new URL(c.req.url).searchParams));
  }

  app.post(PRODUCTS.ask.path, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
    const result = await ask(db, deps.llm, String(body.question ?? ""), { ceiling: PRODUCTS.ask.price });
    setSettlementOverrides(c, { amount: String(result.bill.total) });
    const usedKenya = result.bill.data.some((d) => d.tool.startsWith("kenya_"));
    return c.json({
      answer: result.answer,
      week: result.week,
      ...(usedKenya ? { kenyaQuarter: await kenya.latestQuarter(db) } : {}),
      bill: { ...result.bill, totalUsdc: result.bill.total / 1e6, ceilingUsdc: result.bill.ceiling / 1e6 },
      source: usedKenya
        ? "SEC Nigeria weekly valuation reports and CMA Kenya quarterly statistical bulletins, via afriradar.com"
        : "SEC Nigeria weekly valuation reports of collective investment schemes, via afriradar.com",
      note: "Data, not investment advice.",
    });
  });

  return app;
}

/** Default chain reader for production: JSON-RPC against the configured endpoint, for one network's USDC. */
export const chainReader = (rpc: Parameters<typeof readPayment>[0], treasury: string, mint: string = USDC_DEVNET) => (sig: string) => readPayment(rpc, sig, treasury, mint);
