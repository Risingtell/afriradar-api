// The AfriRadar Data API as a Hono app. Runtime-neutral: the Worker wires D1, Workers AI and
// secrets into it; tests wire sqlite and fakes. Payments are x402 on Solana, settled by our own
// facilitator, and every settlement is written to a public ledger anyone can check on chain.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/hono";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { ExactSvmScheme as ExactServer } from "@x402/svm/exact/server";
import { UptoSvmScheme as UptoServer } from "@x402/svm/upto/server";
import { getBase64Decoder, getBase64Encoder, getTransactionDecoder, type MessagePartialSigner, type TransactionSigner } from "@solana/kit";
import { ask, AskError, questionProblem, type Llm } from "./agent/ask.js";
import { CHAINS, chainOf, explorerUrl, MAINNET, NETWORK, PRODUCTS, USDC_DEVNET, usd, type ProductId } from "./catalog.js";
import type { Db } from "./db.js";
import { CATEGORIES, isCategory } from "./data/model.js";
import * as kenya from "./data/kenya.js";
import * as q from "./data/queries.js";
import { mountDemo } from "./demo.js";
import { discoveryExtension, mountDiscovery } from "./discovery.js";
import { mountFaucet } from "./faucet.js";
import { TOPUP_ROUTES, topupService, mountTopup } from "./topup.js";
import { bump, hourOf } from "./limits.js";
import { mcpTools, mountMcp } from "./mcp.js";
import { monitorStatus } from "./monitor.js";
import { capProof } from "./proof.js";
import { readPayment, type ChainPayment } from "./reconcile.js";
import { AGENT_WALLET_HEADER, claimMismatch, mainnetAskCap, VERIFIED_AGENT_ASKS_PER_HOUR } from "./concordium/access.js";
import { agentCheck, CONCORDIUM, solanaKeyHex, type ConcordiumNet, type registryRpc } from "./concordium/registry.js";
import { AFRIRADAR_AGENTS, agentCard, OWNER, sha256Hex } from "./concordium/agents.js";
import { AGENT_ROLES, registrationPage } from "./concordium/page.js";
import { MODULE_SCHEMAS } from "./concordium/schemas.js";
import { networkFee, SOL_FALLBACK_USD, type FeeKind } from "./netfee.js";

/**
 * On mainnet a question that fails after its deposit still pays its own network fee (the channel was
 * opened, settled and will be closed); everything else is refunded. On devnet it is refunded in full.
 */
export class MainnetUptoServer extends UptoServer {
  override settleOnCancel(ctx: Parameters<UptoServer["settleOnCancel"]>[0]) {
    const r = super.settleOnCancel(ctx);
    if (!r) return r;
    const fee = Math.max(0, Number(ctx.requirements.amount) - PRODUCTS.ask.price);
    return { ...r, amount: String(fee) };
  }
}

export type Deps = {
  db: Db;
  facilitator: FacilitatorClient;
  /** Told when the chain shows that a payment whose settle was unconfirmed landed, so the payer lock (src/netfee.ts) frees its account. */
  landed?: (payload: PaymentPayload, requirements: PaymentRequirements, phase: string) => Promise<void>;
  llm: Llm;
  treasury: string;
  authorizer: MessagePartialSigner;
  rpcUrl: string;
  /** Looks a settlement up on chain. Injected so tests never touch the network. */
  readChain: (signature: string) => Promise<ChainPayment>;
  /** Solana mainnet, real USDC. Without it the API sells on devnet only. */
  mainnet?: {
    rpcUrl: string;
    readChain: (signature: string) => Promise<ChainPayment>;
    /** SOL in US dollars, for the network fee every mainnet price includes (src/netfee.ts). */
    solUsd?: () => Promise<number>;
  };
  explorer?: (sig: string, network?: string | null) => string;
  now?: () => Date;
  /** Funded devnet wallet behind the no-wallet demo. Its payments are labelled demo in the ledger. */
  demoSigner?: TransactionSigner;
  /** The facilitator's fee payer: pays the network fee and account rent for faucet sends. */
  feePayer?: TransactionSigner;
  /** Aurora Intents: top up a Solana wallet from other chains. Without it the /v1/topup routes are off. */
  aurora?: { appKey: string; fetch?: typeof fetch };
  /** The newest week the website has published (src/data/freshness.ts), so /v1/status can show any gap. */
  siteWeek?: () => Promise<string | null>;
  /** Concordium Agent Registry checks for paying wallets (src/concordium/). Without it they are off. */
  agents?: { rpc: ReturnType<typeof registryRpc>; concordium?: ConcordiumNet };
};

export const MAINNET_ASKS_PER_HOUR = 30;
export const AGENT_CHECKS_PER_HOUR = 60;
/** The largest request body accepted: every route takes small JSON. */
export const MAX_BODY_BYTES = 128 * 1024;
/** Redeems per visitor per hour: each one reads the chain, up to 8 times. */
export const REDEEMS_PER_HOUR = 30;
/** How long after a payment it can be redeemed: far longer than a Solana transaction can take to land. */
export const REDEEM_WINDOW_MS = 86_400_000;
/** The detail of a payment the chain itself showed failed, as opposed to one only reported failed. */
const CHAIN_FAILED = "chain says failed";

/** What a payment header accepted; null when unreadable (the payment middleware then refuses it). */
const paidOffer = (header: string): { network: string | null; amount: string | null } | null => {
  try {
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (ch) => ch.charCodeAt(0)))) as { accepted?: { network?: string; amount?: string }; network?: string };
    return { network: p.accepted?.network ?? p.network ?? null, amount: p.accepted?.amount ?? null };
  } catch {
    return null;
  }
};
const paidNetwork = (header: string): string | null => paidOffer(header)?.network ?? null;

/** A price list for one network: the list price, plus on mainnet the buyer's own network fee. */
export type Pricer = (network: string, scheme: FeeKind, listMicro: number) => Promise<number>;

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
  const agents = deps.agents;
  const checkAgent = agents ? (wallet: string, network: string, store = true) => agentCheck(db, wallet, network, { rpc: agents.rpc, concordium: agents.concordium, now: now(), store }) : undefined;
  // AfriRadar never pays a customer's network fee on mainnet: each mainnet price includes the fee
  // of the transactions that payment causes, in USDC at the live SOL price. Devnet has no fee.
  const solUsd = mainnet?.solUsd ?? (async () => SOL_FALLBACK_USD);
  const feeOn = async (network: string, scheme: FeeKind): Promise<number> => (network === MAINNET && mainnet ? networkFee(scheme, await solUsd()) : 0);
  const priceOn: Pricer = async (network, scheme, listMicro) => listMicro + (await feeOn(network, scheme));
  // The SOL price is read per server instance, so a buyer can hold a quote one $10 step above what
  // this instance now asks. Honor any mainnet quote between today's price and the highest fee we
  // could ever ask (never below cost), so that buyer is not refused.
  const mainnetPrice = (scheme: FeeKind, listMicro: number) => async (ctx: { paymentHeader?: string }) => {
    const now = await priceOn(MAINNET, scheme, listMicro);
    const offer = ctx.paymentHeader ? paidOffer(ctx.paymentHeader) : null;
    const quoted = Number(offer?.amount);
    const highest = listMicro + networkFee(scheme, Math.max(SOL_FALLBACK_USD, await solUsd()) * 1.5);
    return usd(offer?.network === MAINNET && Number.isInteger(quoted) && quoted >= now && quoted <= highest ? quoted : now);
  };
  const topup = deps.aurora ? topupService({ appKey: deps.aurora.appKey, fetch: deps.aurora.fetch, db, now, treasury: deps.treasury }) : undefined;

  const record = (row: { id: string; tx: string | null; network: string; route: string; scheme: string; amount: string; ceiling?: string | null; payer?: string | null; status: string; detail?: string | null; createdAt?: string }) =>
    db.run(
      `INSERT INTO payments (id, tx, network, route, scheme, amount, ceiling, payer, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, amount = excluded.amount, detail = excluded.detail, payer = coalesce(payments.payer, excluded.payer)`,
      row.id, row.tx, row.network, row.route, row.scheme, row.amount, row.ceiling ?? null, row.payer ?? null, row.status, row.detail ?? null, row.createdAt ?? now().toISOString(),
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
    const [apiWeek, siteWeek] = await Promise.all([q.latestWeek(db), deps.siteWeek ? deps.siteWeek() : Promise.resolve(null)]);
    // The paid data must never be older than the free website. An hourly job closes any gap within the hour.
    const data = { week: apiWeek, siteWeek, behindSite: !!(siteWeek && (!apiWeek || apiWeek < siteWeek)) };
    return { ...(await monitorStatus(db, now(), explorer)), data, payments7d: { settled: p?.settled ?? 0, failed: p?.failed ?? 0 }, ledger: await ledgerTotals() };
  };

  const resourceServer = new x402ResourceServer(deps.facilitator)
    .register(NETWORK as Network, new ExactServer())
    .register(NETWORK as Network, new UptoServer({ receiverAuthorizerSigner: deps.authorizer, rpcUrl: deps.rpcUrl }));
  if (mainnet) {
    resourceServer
      .register(MAINNET as Network, new ExactServer())
      .register(MAINNET as Network, new MainnetUptoServer({ receiverAuthorizerSigner: deps.authorizer, rpcUrl: mainnet.rpcUrl }));
  }
  // A refused buyer-built transaction goes to the Worker log (never the public ledger), so a wallet
  // layout we do not accept yet can be read with `wrangler tail` and fixed from the real bytes.
  // Only refusals of the transaction's layout (the instructions a wallet added), not amounts, expiry,
  // RPC, simulation or blockhash trouble, and at most 20 a minute per isolate, so a stream of junk
  // payments cannot flood the log.
  const REFUSAL = /^invalid_exact_svm_payload_(transaction_instructions|invalid_lighthouse|transaction_fee_payer|unknown_|no_transfer|memo_|excessive_signers)|verifyOpenTransaction:/;
  let logWindow = { minute: 0, count: 0 };
  const logRefused = (stage: "verify" | "settle", payload: { payload?: unknown }, req: { scheme: string; network: string }, why: string) => {
    if (!REFUSAL.test(why)) return;
    const minute = Math.floor(Date.now() / 60_000);
    if (logWindow.minute !== minute) logWindow = { minute, count: 0 };
    if (++logWindow.count > 20) return;
    const p = (payload.payload ?? {}) as { transaction?: unknown; openTransaction?: unknown };
    const tx = p.transaction ?? p.openTransaction;
    if (typeof tx === "string") console.warn(JSON.stringify({ refused: stage, scheme: req.scheme, network: req.network, why: why.slice(0, 400), tx: tx.slice(0, 2400) }));
  };
  resourceServer
    // The in-process facilitator answers a refused transaction with isValid: false (no throw), so a
    // refused data request is caught here; onVerifyFailure only sees errors that were thrown.
    .onAfterVerify(async (ctx) => {
      if (!ctx.result.isValid) logRefused("verify", ctx.paymentPayload, ctx.requirements, `${ctx.result.invalidReason}: ${ctx.result.invalidMessage ?? ""}`);
    })
    .onVerifyFailure(async (ctx) => {
      logRefused("verify", ctx.paymentPayload, ctx.requirements, ctx.error.message);
    })
    .onAfterSettle(async (ctx) => {
      const r = ctx.result;
      const status = ctx.phase === "before-handler" ? "deposit" : ctx.phase === "cancel" ? "refunded" : "settled";
      await record({
        id: `${r.transaction}:${status}`,
        tx: r.transaction || null,
        network: ctx.requirements.network,
        route: pathOf(ctx.paymentPayload.resource?.url),
        scheme: ctx.requirements.scheme,
        amount: status === "deposit" ? String(ctx.requirements.amount) : status === "refunded" ? (r.amount ?? "0") : (r.amount ?? String(ctx.requirements.amount)),
        ceiling: ctx.requirements.scheme === "upto" ? String(ctx.requirements.amount) : null,
        payer: r.payer ?? null,
        status,
      });
      // Look the payer up in the Concordium Agent Registry so the public ledger can show its badge. At most
      // once an hour per wallet, and never holding the buyer's answer back by more than a moment.
      if (checkAgent && r.payer && status !== "refunded") {
        await Promise.race([checkAgent(r.payer, ctx.requirements.network).catch(() => undefined), new Promise((ok) => setTimeout(ok, 1500))]);
      }
    })
    // A buyer that named a verified agent wallet for the agents' question cap must pay from that wallet.
    .onAfterVerify(async (ctx) => {
      const t = ctx.transportContext as { request?: { adapter?: { getHeader(name: string): string | undefined } } } | undefined;
      const reason = claimMismatch(t?.request?.adapter?.getHeader(AGENT_WALLET_HEADER) ?? null, ctx.result.payer ?? null);
      if (reason) return { abort: true as const, reason: "agent_wallet_mismatch", message: reason };
    })
    // A "settlement_pending" answer means the transaction was broadcast but its confirmation was
    // not seen (often an RPC rate limit); so does one whose pending record could not be written.
    // The buyer may already have paid, so read the chain before withholding what they bought.
    // Recovered only when the treasury really received it.
    .onSettleFailure(async (ctx) => {
      const err = ctx.error as Error & { errorReason?: string; errorMessage?: string; transaction?: string; payer?: string };
      const tx = err.transaction;
      const route = pathOf(ctx.paymentPayload.resource?.url);
      const network = ctx.requirements.network;
      // Refused before anything was sent (an earlier payment from the account is still in flight, or the
      // paying account is named through a lookup table): no payment happened, so none goes in the
      // ledger. Logged, so a buyer's report of a failed payment can be matched.
      if (err.errorReason === "payer_busy" || err.errorReason === "payment_account_in_lookup_table") {
        console.warn(JSON.stringify({ refused: "settle", why: err.errorReason, network, route }));
        return;
      }
      const broadcast = err.errorReason === "settlement_pending" || (err.errorMessage ?? "").startsWith("settlement_pending, but failed to persist");
      const recovered = `recovered from chain after ${err.errorReason === "settlement_pending" ? "settlement_pending" : "a broadcast whose pending record was not saved"}`;
      if (!broadcast || !tx) {
        // The chain already showed this transaction failed (an earlier attempt): that stays the record.
        if (tx && (await db.first("SELECT 1 FROM payments WHERE tx = ? AND status = 'failed' AND detail = ?", tx, CHAIN_FAILED))) return;
        logRefused("settle", ctx.paymentPayload, ctx.requirements, err.message || err.errorReason || "");
        // err.message is "reason: explanation"; the reason code alone does not say what to fix.
        await record({ id: `${tx || crypto.randomUUID()}:failed`, tx: tx || null, network, route, scheme: ctx.requirements.scheme, amount: "0", payer: err.payer, status: "failed", detail: err.message || err.errorReason });
        return;
      }
      const chain = await readChainOn(network)(tx);
      // Landed, confirmed or failed: it cannot land again, so the buyer's next payment need not wait for it.
      if (chain.status !== "unknown") await deps.landed?.(ctx.paymentPayload as PaymentPayload, ctx.requirements as PaymentRequirements, ctx.phase).catch(() => undefined);
      // A question's deposit opens a payment channel: the money goes into the channel, not to the
      // treasury, so it has been received once its open transaction is confirmed. The facilitator
      // checked that transaction (deposit, payee, mint) before sending it, so a confirmed one is that
      // channel; the handler then answers and the claim settles from the channel as usual. A deposit
      // whose send threw never gets here: it has no transaction to read (and the facilitator dropped
      // its record of the channel), so it fails above.
      if (ctx.requirements.scheme === "upto" && ctx.phase === "before-handler" && chain.status === "confirmed") {
        const amount = String(ctx.requirements.amount);
        await db.run("DELETE FROM payments WHERE tx = ? AND status = 'pending'", tx); // an earlier attempt's, now resolved
        await record({ id: `${tx}:deposit`, tx, network, route, scheme: "upto", amount, ceiling: amount, payer: err.payer, status: "deposit", detail: recovered });
        // The resource server's retry left the facilitator a pending note for this deposit. Clear it, or a
        // replay of the same payment would be reconciled into a fresh deposit and the question answered
        // again against a channel already claimed. (The library's own reconcile of such a note returns
        // success without reading the channel either: the open was checked before it was sent.)
        const open = (ctx.paymentPayload.payload as { openTransaction?: unknown }).openTransaction;
        if (typeof open === "string") {
          await depositNoteKey(ctx.requirements.network, open)
            .then(async (k) => {
              const { changes } = await db.run("DELETE FROM kv WHERE ns = 'pending' AND k = ?", k);
              // Expected when the note was never saved; otherwise the library changed its key (see test/recovery.test.ts).
              if (changes === 0) console.warn(JSON.stringify({ recovery: "no pending note found for this deposit", tx }));
            })
            .catch((e) => console.warn(JSON.stringify({ recovery: "could not clear the deposit's pending note", tx, error: String((e as Error)?.message ?? e) })));
        }
        return { recovered: true as const, result: { success: true, transaction: tx, network: ctx.requirements.network, payer: err.payer, amount } };
      }
      const expected = BigInt(ctx.requirements.scheme === "upto" ? 1 : ctx.requirements.amount);
      if (chain.status === "confirmed" && chain.received >= expected) {
        await db.run("DELETE FROM payments WHERE tx = ? AND status = 'pending'", tx); // an earlier attempt's, now resolved
        await record({ id: `${tx}:settled`, tx, network, route, scheme: ctx.requirements.scheme, amount: chain.received.toString(), payer: err.payer, status: "settled", detail: recovered });
        return {
          recovered: true as const,
          result: { success: true, transaction: tx, network: ctx.requirements.network, payer: err.payer, amount: chain.received.toString() },
        };
      }
      if (chain.status === "failed") {
        // Landed and failed: it charged nothing and never will. One failed row, in place of any pending one.
        await db.run("DELETE FROM payments WHERE tx = ? AND status = 'pending'", tx);
        await record({ id: `${tx}:failed`, tx, network, route, scheme: ctx.requirements.scheme, amount: "0", payer: err.payer, status: "failed", detail: CHAIN_FAILED });
        return;
      }
      // Already shown failed by the chain (an earlier attempt): a later "unknown" read changes nothing.
      if (await db.first("SELECT 1 FROM payments WHERE tx = ? AND status = 'failed' AND detail = ?", tx, CHAIN_FAILED)) return;
      await record({ id: `${tx}:pending`, tx, network, route, scheme: ctx.requirements.scheme, amount: "0", payer: err.payer, status: "pending", detail: ctx.requirements.scheme === "exact" && route.startsWith("/v1/") ? `chain says ${chain.status}; redeem at /v1/redeem/${tx}` : `chain says ${chain.status}` });
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
          // Mainnet: the list price plus the buyer's network fee, read when the 402 is built.
          price: ch.id === "mainnet" ? mainnetPrice(p.scheme, p.price) : usd(p.price),
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
  app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"], allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT", AGENT_WALLET_HEADER] }));
  // Every body this API takes is small JSON (a question, an MCP call, an address). Refusing anything
  // larger, even sent without a length, keeps a huge body from reaching any parser (GHSA-mrhx-c7xc-m3w5
  // lets a large enough array exhaust the memory of the zod copy the x402 libraries still use). After
  // cors, so the refusal carries the CORS headers a browser needs to read it.
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: `request bodies are limited to ${MAX_BODY_BYTES / 1024} KB` }, 413) }));
  app.onError((e, c) => {
    if (e instanceof AskError) return c.json({ error: e.message }, e.status);
    console.error(e);
    return c.json({ error: "internal error, you were not charged" }, 500);
  });

  // ---------- free ----------
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1", async (c) => {
    const week = await q.latestWeek(db);
    const fees = mainnet ? { exact: await feeOn(MAINNET, "exact"), upto: await feeOn(MAINNET, "upto") } : null;
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
      free: ["GET /v1", "GET /v1/overview", "GET /v1/search?q=", "GET /v1/payments", "GET /v1/status", ...(agents ? ["GET /v1/agents/:wallet"] : []), "GET /v1/proof/cap", "GET /v1/redeem/:tx", "GET /discovery/resources", "POST /mcp", ...(topup ? TOPUP_ROUTES : [])],
      mcp: "https://api.afriradar.com/mcp: the same data as MCP tools, paid tools charged over x402 inside MCP.",
      ...(topup ? { topup: "No USDC on Solana? GET /v1/topup: send USDT or USDC from BNB Chain, Tron, Base, Arbitrum or Polygon, and Aurora Intents delivers USDC to your Solana wallet." } : {}),
      products: Object.entries(PRODUCTS).map(([id, p]) => ({
        id, method: p.method, path: p.path, scheme: p.scheme, price: usd(p.price), priceMicroUsdc: p.price,
        ...(fees ? { mainnet: { price: usd(p.price + fees[p.scheme]), priceMicroUsdc: p.price + fees[p.scheme], networkFee: usd(fees[p.scheme]) } } : {}),
        summary: p.summary, example: p.example,
      })),
      ...(fees ? { networkFee: "On mainnet each price includes the Solana network fee of that payment, in USDC at the live SOL price, so you need no SOL and AfriRadar pays no fee for you. Devnet has no fee." } : {}),
      failedPayments: "A request that errors is never charged for its data. On mainnet a question that fails after its deposit still pays its own network fee; the rest of the deposit is refunded. If a settlement is broadcast but unconfirmed, the server checks the chain before replying; anything still unresolved can be redeemed at /v1/redeem/:tx.",
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
      `SELECT p.tx, p.network, p.route, p.scheme, p.amount, p.ceiling, p.payer, p.status, p.detail, p.created_at, a.verified AS agent_verified, a.badge AS agent_badge
       FROM payments p LEFT JOIN agent_checks a ON a.wallet = p.payer AND a.solana_network = p.network
       ${only ? "WHERE p.network = ?" : ""} ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`,
      ...(only ? [only] : []), Math.min(Number(c.req.query("limit")) || 50, 200), Math.max(Number(c.req.query("offset")) || 0, 0),
    );
    const t = await ledgerTotals();
    return c.json({
      settled: t.settled,
      visitors: t.visitors,
      monitor: t.monitor,
      networks: t.networks,
      network: want,
      recent: rows.map(({ agent_verified, agent_badge, ...r }) => ({ ...r, agent: Number(agent_verified) === 1 ? { verified: true, badge: agent_badge, check: `/v1/agents/${r.payer}?network=${chainOf(r.network).id}` } : null, chain: chainOf(r.network).id, usdc: Number(r.amount) / 1e6, monitor: r.detail === "monitor", demo: !!deps.demoSigner && r.payer === deps.demoSigner.address && r.detail !== "monitor", explorer: r.tx ? explorer(r.tx, r.network) : null })),
      demoWallet: deps.demoSigner?.address ?? null,
      verify: `These rows are ${want === "all" ? "Solana devnet and mainnet" : chainOf(only).label} transactions (?network=${chains.map((ch) => ch.id).join("|")}|all). Recount them from the chain in your browser at https://api.afriradar.com/#ledger, or run \`npx afriradar verify\`.`,
    });
  });
  // Paid but unconfirmed at reply time? Once the chain shows the money arrived, the data is released
  // free, for a day after the payment (a Solana transaction lands within about a minute and a half, or
  // never). Only for a payment whose data was never served: still pending, already redeemed (its buyer
  // may ask again), or marked failed without the chain having shown it. A payment served when it was
  // paid, as nearly every one in the public ledger was, cannot be redeemed. Not once only: transaction
  // ids are public, so a first redeem by someone else must not use up the buyer's. The day also closes
  // older ledger rows that an earlier version of this route marked "redeemed" on served payments.
  app.get("/v1/redeem/:tx", async (c) => {
    const tx = c.req.param("tx");
    const rows = await db.all<{ network: string; route: string; scheme: string; status: string; detail: string | null; payer: string | null; created_at: string }>(
      "SELECT network, route, scheme, status, detail, payer, created_at FROM payments WHERE tx = ?",
      tx,
    );
    if (!rows.length) return c.json({ error: "no payment with that transaction" }, 404);
    const row = rows.find((r) => r.status === "pending") ?? rows.find((r) => r.status === "settled") ?? rows[0];
    if (row.scheme !== "exact" || !row.route.startsWith("/v1/")) return c.json({ error: "only data products can be redeemed; a metered /v1/ask is never charged unless it was answered" }, 400);
    if (rows.some((r) => r.status === "settled" && r.detail !== "redeemed")) return c.json({ status: "settled", error: "this payment's data was served when it was paid" }, 409);
    const paidAt = Math.min(...rows.map((r) => Date.parse(r.created_at)));
    if (now().getTime() - paidAt > REDEEM_WINDOW_MS) return c.json({ error: "a payment can be redeemed for a day after it was made" }, 409);
    if (rows.some((r) => r.status === "failed" && r.detail === CHAIN_FAILED)) return c.json({ status: "failed", error: "this payment failed and was never charged" }, 409);
    if (!rows.some((r) => r.status === "pending" || r.status === "settled" || r.status === "failed")) {
      return c.json({ status: row.status, error: "only a payment still pending can be redeemed" }, 409);
    }
    // Each redeem past here reads the chain, up to 8 times: keep anyone from spending our RPC quota through it.
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    if ((await bump(db, "redeem", `ip:${ip}:${hourOf(now())}`, now())) > REDEEMS_PER_HOUR) return c.json({ error: `redeem runs ${REDEEMS_PER_HOUR} times an hour per visitor; try later` }, 429);
    const chain = await readChainOn(row.network)(tx);
    if (chain.status === "failed") {
      await db.run("DELETE FROM payments WHERE tx = ? AND status IN ('pending', 'failed')", tx);
      await record({ id: `${tx}:failed`, tx, network: row.network, route: row.route, scheme: row.scheme, amount: "0", payer: row.payer, status: "failed", detail: CHAIN_FAILED });
      return c.json({ status: "failed", error: "this payment failed and was never charged" }, 409);
    }
    if (chain.status === "confirmed" && chain.received <= 0n) return c.json({ status: "confirmed", error: "this transaction paid nothing to AfriRadar's treasury" }, 409);
    // Unknown stays "try again": the chain read cannot tell a transaction that never landed from an RPC
    // that did not answer, and closing a payment that did land would cost its buyer what they paid for.
    if (chain.status !== "confirmed") return c.json({ status: chain.status, message: "not confirmed on chain yet, try again shortly" }, 409);
    // Any amount above zero will do: the facilitator checked the transfer's amount before sending it, so
    // a payment that landed paid its price. "Confirmed" is the commitment the facilitator settles at too.
    // Dated at the payment, so the redeem window keeps running from the payment, not from this redeem.
    await record({ id: `${tx}:settled`, tx, network: row.network, route: row.route, scheme: row.scheme, amount: chain.received.toString(), payer: row.payer, status: "settled", detail: "redeemed", createdAt: new Date(paidAt).toISOString() });
    await db.run("DELETE FROM payments WHERE tx = ? AND status IN ('pending', 'failed')", tx); // the redeemed row keeps it redeemable
    return serveData(c, new URL(row.route, "https://x").pathname, new URL(row.route, "https://x").searchParams);
  });

  app.get("/v1/status", async (c) => c.json(await status()));

  // AfriRadar's own agents in the Concordium Agent Registry: their cards (served byte for byte, since the
  // registry anchors each card's SHA-256), the registration plan, and the page that walks through it.
  const cardResponse = (text: string) => new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
  app.get("/.well-known/agent-card.json", () => cardResponse(agentCard(AFRIRADAR_AGENTS.seller)));
  app.get("/agents/buyer.json", () => cardResponse(agentCard(AFRIRADAR_AGENTS.buyer)));
  app.get("/concordium/agents", async (c) => c.json({
    owner: OWNER,
    registry: CONCORDIUM.testnet,
    agents: await Promise.all(Object.values(AFRIRADAR_AGENTS).map(async (a) => ({
      id: a.id, name: a.name, role: AGENT_ROLES[a.id], agentUri: a.agentUri, cardSha256: await sha256Hex(agentCard(a)),
      wallet: a.wallet, solanaNetwork: a.solanaNetwork, tokenId: a.tokenId, badge: a.badge,
      externalKey: { namespace: a.solanaNetwork, key_type: "ed25519", public_key_hex: solanaKeyHex(a.wallet) },
      proof: a.cis8Signature ? { scheme: "solana-ed25519", signature_hex: a.cis8Signature } : null,
    }))),
    schemas: MODULE_SCHEMAS,
  }));
  app.get("/concordium", (c) => c.html(registrationPage()));

  // Is this Solana wallet a verified Concordium agent? Free, for buyers, sellers and anyone checking the ledger.
  if (checkAgent && agents) {
    app.get("/v1/agents/:wallet", async (c) => {
      const want = c.req.query("network") ?? "devnet";
      if (!chains.some((ch) => ch.id === want)) return c.json({ error: `network must be ${chains.map((ch) => ch.id).join(" or ")}` }, 400);
      const ip = c.req.header("cf-connecting-ip") ?? "local";
      if ((await bump(db, "agent-check", `ip:${ip}:${hourOf(now())}`, now())) > AGENT_CHECKS_PER_HOUR) return c.json({ error: `the agent check runs ${AGENT_CHECKS_PER_HOUR} times an hour per visitor; try later` }, 429);
      const wallet = c.req.param("wallet");
      const network = CHAINS[want as keyof typeof CHAINS].network;
      // Kept for an hour only for wallets that have paid here; anyone else's check is read and not written.
      const paid = !!(await db.first("SELECT 1 AS x FROM payments WHERE payer = ? AND network = ? LIMIT 1", wallet, network));
      const check = await checkAgent(wallet, network, paid);
      const net = CONCORDIUM[agents.concordium ?? "testnet"];
      return c.json({
        ...check,
        registry: { concordium: net.network, cis8004: `${net.cis8004.index},${net.cis8004.subindex}`, cis8: `${net.cis8.index},${net.cis8.subindex}`, explorer: net.explorer },
        perk: `A verified agent that names its wallet in the ${AGENT_WALLET_HEADER} header may ask ${VERIFIED_AGENT_ASKS_PER_HOUR} mainnet questions an hour instead of ${MAINNET_ASKS_PER_HOUR}, and its payments carry its badge in the public ledger (/v1/payments).`,
      });
    });
  }

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
  // would be refunded at the cost of two network fees. So a paid request with a bad question
  // is turned away before any channel opens; an unpaid one still gets its 402 price. Mainnet questions
  // are also capped per visitor, because each open channel holds some of the facilitator's SOL as
  // rent until the hourly cleanup returns it (the rent comes back; the fees are in the buyer's price).
  app.post(PRODUCTS.ask.path, async (c, next) => {
    const paid = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT");
    if (!paid) return next();
    const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
    const problem = questionProblem(String(body.question ?? ""));
    if (problem) return c.json({ error: `${problem}; you were not charged` }, 400);
    if (paidNetwork(paid) === MAINNET) {
      const cap = await mainnetAskCap({
        db, now: now(), ip: c.req.header("cf-connecting-ip") ?? "local", visitorCap: MAINNET_ASKS_PER_HOUR,
        claimed: c.req.header(AGENT_WALLET_HEADER) ?? null,
        check: checkAgent ? (wallet) => checkAgent(wallet, MAINNET) : undefined,
      });
      if (!cap.ok) return c.json({ error: cap.error }, 429);
    }
    return next();
  });

  if (deps.demoSigner) mountDemo(app, { db, signer: deps.demoSigner, rpcUrl: deps.rpcUrl, explorer, now });
  if (deps.demoSigner && deps.feePayer) mountFaucet(app, { db, source: deps.demoSigner, feePayer: deps.feePayer, rpcUrl: deps.rpcUrl, explorer, now });
  if (topup) mountTopup(app, { service: topup });
  const networks = chains.map((ch) => ch.network as Network);
  mountMcp(app, { db, resourceServer, treasury: deps.treasury, networks, status, topup, priceOn });
  mountDiscovery(app, { resourceServer, treasury: deps.treasury, networks, tools: mcpTools(db, { status, networks, topup }), now, priceOn });

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
    // On mainnet the buyer authorized the list ceiling plus the network fee; the fee is charged on
    // top of what the question used, never more than was authorized.
    const offer = paidOffer(c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? "");
    const authorized = Number(offer?.amount ?? PRODUCTS.ask.price);
    const fee = offer?.network === MAINNET ? Math.max(0, authorized - PRODUCTS.ask.price) : 0;
    const charged = Math.min(result.bill.total + fee, authorized);
    setSettlementOverrides(c, { amount: String(charged) });
    const usedKenya = result.bill.data.some((d) => d.tool.startsWith("kenya_"));
    return c.json({
      answer: result.answer,
      week: result.week,
      ...(usedKenya ? { kenyaQuarter: await kenya.latestQuarter(db) } : {}),
      bill: { ...result.bill, totalUsdc: result.bill.total / 1e6, ceilingUsdc: result.bill.ceiling / 1e6, ...(fee ? { networkFee: fee, charged, networkFeeUsdc: fee / 1e6, chargedUsdc: charged / 1e6 } : {}) },
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

/** The upto facilitator's pending-note key for a deposit (@x402/svm 2.28.0: the base64 SHA-256 of the open's message). */
export async function depositNoteKey(network: string, openTransaction: string): Promise<string> {
  const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(openTransaction));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(messageBytes)));
  return `upto:deposit:${network}:${getBase64Decoder().decode(digest)}`;
}
