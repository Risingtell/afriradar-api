// Top up a Solana wallet from another chain with Aurora Intents. Most crypto in Africa sits in USDT on
// BNB Chain or Tron, and many agents hold USDC on Base, while this API is paid in USDC on Solana. A
// buyer asks for a one-time deposit address, sends the tokens there from any wallet or exchange, and
// Aurora's intents network delivers USDC to the buyer's own Solana wallet, ready to pay over x402.
// AfriRadar never holds the money: the deposit address belongs to the intents network, and a swap
// that cannot complete is refunded to the buyer's refund address on the source chain.
import type { Context, Hono } from "hono";
import { isAddress } from "@solana/kit";
import { USDC_MAINNET } from "./catalog.js";
import type { Db } from "./db.js";
import { bump, hourOf } from "./limits.js";

export const AURORA_API = "https://intents-api.aurora.dev";
/** USDC on Solana (mint EPjFWdd5...) as Aurora's token list names it. */
export const SOLANA_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";

type Kind = "evm" | "tron" | "solana";
/** `tx`: the block explorer's transaction link prefix, used when Aurora sends a hash without a link. */
export type TopupSource = { id: string; chain: string; token: string; assetId: string; decimals: number; kind: Kind; max: number; tx: string };

const SOLANA_TX = "https://explorer.solana.com/tx/";

/** Asset ids from Aurora's token list (GET /api/tokens), checked against live quotes on 7 November 2026. */
export const TOPUP_SOURCES: TopupSource[] = [
  { id: "bsc-usdt", chain: "BNB Smart Chain", token: "USDT", assetId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", decimals: 18, kind: "evm", max: 1000, tx: "https://bscscan.com/tx/" },
  { id: "tron-usdt", chain: "Tron", token: "USDT", assetId: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", decimals: 6, kind: "tron", max: 1000, tx: "https://tronscan.org/#/transaction/" },
  { id: "base-usdc", chain: "Base", token: "USDC", assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, kind: "evm", max: 1000, tx: "https://basescan.org/tx/" },
  { id: "arb-usdc", chain: "Arbitrum", token: "USDC", assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, kind: "evm", max: 1000, tx: "https://arbiscan.io/tx/" },
  { id: "pol-usdt", chain: "Polygon", token: "USDT", assetId: "nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr", decimals: 6, kind: "evm", max: 1000, tx: "https://polygonscan.com/tx/" },
  { id: "sol", chain: "Solana", token: "SOL", assetId: "nep141:sol.omft.near", decimals: 9, kind: "solana", max: 10, tx: SOLANA_TX },
  { id: "sol-usdt", chain: "Solana", token: "USDT", assetId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", decimals: 6, kind: "solana", max: 1000, tx: SOLANA_TX },
];

const REFUND_OK: Record<Kind, (s: string) => boolean> = {
  evm: (s) => /^0x[0-9a-fA-F]{40}$/.test(s),
  tron: (s) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s),
  solana: (s) => isAddress(s),
};
const REFUND_EXAMPLE: Record<Kind, string> = { evm: "0x...", tron: "T...", solana: "a Solana address" };

/**
 * Stand-ins for a price check (dry quote) made before the buyer has typed their own addresses. A dry
 * quote never creates a deposit address, so nothing can ever be sent to or refunded to these. They
 * are fixed so a dry quote is repeatable; nobody holds their keys.
 */
const DRY_REFUND: Record<Kind, string> = {
  evm: "0x59bac2bf558394b5c54c6e2b203054e24dd4f42f",
  tron: "TTvz7QmSxFRwUMJfiz7CC3KuHEQo9hFXJN",
  solana: "",
};

/**
 * Aurora allows 2,000 calls an hour per key and endpoint, so real quotes plus price checks stay under
 * 1,600 and status checks under 1,500. Each visitor also has its own hourly allowance, shared by the
 * HTTP routes and the MCP tools, so no one caller can spend the key's quota for everyone.
 */
export const TOPUP_LIMITS = {
  quotesPerHour: 600,
  dryQuotesPerHour: 1000,
  statusPerHour: 1500,
  quotesPerVisitorHour: 30,
  dryQuotesPerVisitorHour: 120,
  statusPerVisitorHour: 600,
  timeoutMs: 20_000,
  statusCacheMs: 5_000,
  dryCacheMs: 30_000,
  quoteMinutes: 30,
};

export class TopupError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 429 | 502 | 503, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const AMOUNT = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,18})?$/;

/** "0.5" with 18 decimals -> 500000000000000000n. Null for anything that is not a plain decimal. */
export function toUnits(amount: string, decimals: number): bigint | null {
  if (!AMOUNT.test(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
/** Base units from Aurora: only a plain digit string is trusted. */
const digits = (v: unknown) => (typeof v === "string" && /^\d{1,40}$/.test(v) ? BigInt(v) : null);
/** Aurora's hashes, each with a link: Aurora's own when it gives one, else built from the chain's explorer. */
const txs = (list: unknown, prefix?: string) =>
  (Array.isArray(list) ? list : []).map((t: { hash?: string; explorerUrl?: string }) => {
    const hash = String(t.hash ?? "");
    return { hash, explorer: t.explorerUrl || (prefix && hash ? `${prefix}${hash}` : null) };
  });

type AuroraQuote = {
  depositAddress?: string; depositMemo?: string | null; deadline?: string; timeEstimate?: number;
  amountIn?: string; amountInFormatted?: string; amountInUsd?: string;
  amountOut?: string; amountOutFormatted?: string; amountOutUsd?: string; minAmountOut?: string;
};
type AuroraSwap = {
  amountInFormatted?: string | null; amountOutFormatted?: string | null; amountOutUsd?: string | null;
  depositedAmountFormatted?: string | null; refundedAmount?: string | null; refundedAmountFormatted?: string | null; refundReason?: string | null;
  originChainTxHashes?: unknown; destinationChainTxHashes?: unknown;
};

export type TopupQuote = {
  dry: boolean;
  from: { id: string; chain: string; token: string };
  send: { amount: string; token: string; chain: string; to: string | null; memo: string | null; usd: number | null };
  receive: { usdc: string; atLeastUsdc: string; usd: number | null; wallet: string | null; chain: "Solana"; mint: string };
  refundTo: string | null;
  estimatedSeconds: number | null;
  deadline: string | null;
  status: string | null;
  via: "Aurora Intents";
};

export type TopupStatus = {
  depositAddress: string;
  status: string;
  done: boolean;
  message: string;
  updatedAt: string | null;
  deposited: string | null;
  received: { usdc: string; usd: number | null } | null;
  refunded: { amount: string; reason: string | null } | null;
  originTxs: { hash: string; explorer: string | null }[];
  solanaTxs: { hash: string; explorer: string | null }[];
  via: "Aurora Intents";
};

const MESSAGES: Record<string, (d: AuroraSwap) => string> = {
  PENDING_DEPOSIT: () => "Waiting for your deposit.",
  KNOWN_DEPOSIT_TX: () => "Deposit seen on the source chain. Waiting for it to confirm.",
  PROCESSING: () => "Deposit received. Converting it to USDC on Solana.",
  SUCCESS: (d) => `Done: ${d.amountOutFormatted ?? "the"} USDC arrived in your Solana wallet.`,
  INCOMPLETE_DEPOSIT: (d) => `The deposit${d.depositedAmountFormatted ? ` (${d.depositedAmountFormatted})` : ""} is less than the quoted amount. Send the rest before the deadline, or Aurora refunds it to your refund address.`,
  REFUNDED: (d) => `Refunded${d.refundedAmountFormatted ? ` ${d.refundedAmountFormatted}` : ""} to your refund address${d.refundReason ? `: ${d.refundReason}` : ""}.`,
  FAILED: () => "The swap failed. Keep this deposit address: Aurora's support can trace it.",
};
const DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export type TopupService = ReturnType<typeof topupService>;

export function topupService(opts: { appKey: string; db: Db; now: () => Date; fetch?: typeof fetch; treasury: string }) {
  const doFetch = opts.fetch ?? fetch;
  const statusCache = new Map<string, { at: number; value: TopupStatus }>();
  const dryCache = new Map<string, { at: number; value: TopupQuote }>();
  const fresh = <T>(cache: Map<string, { at: number; value: T }>, key: string, ms: number) => {
    const hit = cache.get(key);
    return hit && opts.now().getTime() - hit.at < ms ? hit.value : undefined;
  };
  const remember = <T>(cache: Map<string, { at: number; value: T }>, key: string, value: T) => {
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: opts.now().getTime(), value });
  };

  const count = async (ns: string, key: string, max: number, message: string) => {
    const now = opts.now();
    if ((await bump(opts.db, ns, `${key}:${hourOf(now)}`, now)) > max) throw new TopupError(message, 429);
  };
  const perVisitor = (what: "quote" | "dry" | "status", visitor: string) => {
    const [max, label] = what === "quote" ? [TOPUP_LIMITS.quotesPerVisitorHour, "deposit addresses"] : what === "dry" ? [TOPUP_LIMITS.dryQuotesPerVisitorHour, "price checks"] : [TOPUP_LIMITS.statusPerVisitorHour, "status checks"];
    return count(`topup-${what}`, `ip:${visitor}`, max, `the limit is ${max} top-up ${label} an hour per visitor`);
  };
  // Counted before every Aurora call, so no mix of visitors can exhaust the key's hourly quota.
  const budget = (what: "quote" | "dry" | "status") =>
    count("aurora", what, what === "quote" ? TOPUP_LIMITS.quotesPerHour : what === "dry" ? TOPUP_LIMITS.dryQuotesPerHour : TOPUP_LIMITS.statusPerHour, "this hour's top-up budget is used up; try again next hour");

  const call = async (path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    let res: Response;
    try {
      res = await doFetch(`${AURORA_API}${path}`, { ...init, signal: AbortSignal.timeout(TOPUP_LIMITS.timeoutMs) });
    } catch {
      return { status: 0, json: null };
    }
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  // A refused key is our configuration, never the buyer's mistake.
  const keyRefused = (status: number, message: string) => {
    if (status !== 401 && status !== 403) return;
    console.error("Aurora Intents refused the app key", status, message);
    throw new TopupError("top-ups are unavailable right now; try again later", 503);
  };
  const unreachable = () => new TopupError("Aurora Intents did not answer, so no deposit address was created. Try again in a moment.", 502);

  return {
    about() {
      return {
        about: "No USDC on Solana yet? Send USDT or USDC from another chain and Aurora Intents delivers USDC to your Solana wallet, ready to pay this API over x402 on mainnet. AfriRadar never holds the money: the deposit address belongs to Aurora's intents network, and a swap that cannot complete is refunded to your refund address on the source chain.",
        via: "Aurora Intents (https://docs.intents.aurora.dev)",
        receive: { token: "USDC", chain: "Solana", mint: USDC_MAINNET },
        sources: TOPUP_SOURCES.map(({ id, chain, token, decimals, kind, max }) => ({ id, chain, token, decimals, kind, refundAddress: kind === "solana" ? "optional: your Solana wallet is used" : `required: your ${chain} address`, max })),
        steps: [
          "POST /v1/topup/quote {from, amount, wallet, refundTo} with dry: true for a price check: no address is created.",
          "POST the same without dry: you get send.to, a one-time deposit address, and the exact amount to send.",
          "Send that amount of the source token to send.to from any wallet or exchange.",
          "Poll GET /v1/topup/status/<send.to> until done; received.usdc is what reached your wallet, with its Solana transaction.",
        ],
        limits: { depositAddressesPerVisitorPerHour: TOPUP_LIMITS.quotesPerVisitorHour, priceChecksPerVisitorPerHour: TOPUP_LIMITS.dryQuotesPerVisitorHour, statusChecksPerVisitorPerHour: TOPUP_LIMITS.statusPerVisitorHour },
        minimums: "Each route has a minimum that moves with network fees; a quote below it is refused with the current minimum.",
      };
    },

    /** `visitor` is the caller's IP: each visitor has its own hourly allowance. */
    async quote(input: Record<string, unknown>, visitor = "local"): Promise<TopupQuote> {
      const dry = input.dry === true;
      await perVisitor(dry ? "dry" : "quote", visitor);
      const src = TOPUP_SOURCES.find((s) => s.id === String(input.from ?? "").trim());
      if (!src) throw new TopupError(`from must be one of ${TOPUP_SOURCES.map((s) => s.id).join(", ")}`, 400);
      const amount = typeof input.amount === "number" ? String(input.amount) : String(input.amount ?? "").trim();
      const units = toUnits(amount, src.decimals);
      if (units === null || units === 0n) throw new TopupError(`amount must be a positive number of ${src.token} with at most ${src.decimals} decimal places, such as 0.5`, 400);
      if (units > BigInt(src.max) * 10n ** BigInt(src.decimals)) throw new TopupError(`amount can be at most ${src.max} ${src.token} here`, 400);

      const given = String(input.wallet ?? "").trim();
      const wallet = given || (dry ? opts.treasury : ""); // a price check needs some Solana recipient
      if (!isAddress(wallet)) throw new TopupError("wallet must be the Solana address that should receive the USDC", 400);
      const refundGiven = String(input.refundTo ?? "").trim();
      const refundTo = refundGiven || (src.kind === "solana" ? wallet : dry ? DRY_REFUND[src.kind] : "");
      if (!refundTo) throw new TopupError(`refundTo is required: your own ${src.chain} address (${REFUND_EXAMPLE[src.kind]}), where Aurora returns the ${src.token} if the swap cannot complete`, 400);
      if (!REFUND_OK[src.kind](refundTo)) throw new TopupError(`refundTo must be a ${src.chain} address (${REFUND_EXAMPLE[src.kind]})`, 400);
      // Report a refund address only when it is the buyer's own: typed, or their own Solana wallet.
      // A stand-in (our treasury or a placeholder) must never be copied into a real quote.
      const ownRefund = refundGiven || (src.kind === "solana" && given) ? refundTo : null;

      const cacheKey = `${src.id}|${units}|${given}|${refundGiven}`;
      if (dry) {
        const hit = fresh(dryCache, cacheKey, TOPUP_LIMITS.dryCacheMs);
        if (hit) return hit;
      }
      await budget(dry ? "dry" : "quote");
      const body = {
        dry,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: src.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: SOLANA_USDC,
        amount: units.toString(),
        refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: wallet,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(opts.now().getTime() + TOPUP_LIMITS.quoteMinutes * 60_000).toISOString(),
      };
      const { status, json } = await call(`/api/quote/${encodeURIComponent(opts.appKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const message = typeof json?.message === "string" ? json.message : "";
      if (status === 429) throw new TopupError("Aurora Intents is busy; try again in a minute", 503);
      keyRefused(status, message);
      if (status >= 400 && status < 500) {
        const low = digits(/try at least (\d+)/i.exec(message)?.[1]);
        if (low !== null) {
          const minimum = fromUnits(low, src.decimals);
          throw new TopupError(`below the minimum for ${src.token} on ${src.chain}: send at least ${minimum} ${src.token}`, 400, { minimum, token: src.token });
        }
        throw new TopupError(`Aurora Intents refused this quote: ${message || `HTTP ${status}`}`, 400);
      }
      const q = json?.quote as AuroraQuote | undefined;
      const atLeast = digits(q?.minAmountOut);
      if (status !== 200 || !q?.amountOutFormatted || atLeast === null || (!dry && !q.depositAddress)) throw unreachable();

      const value: TopupQuote = {
        dry,
        from: { id: src.id, chain: src.chain, token: src.token },
        send: { amount: q.amountInFormatted ?? amount, token: src.token, chain: src.chain, to: dry ? null : (q.depositAddress as string), memo: dry ? null : (q.depositMemo ?? null), usd: num(q.amountInUsd) },
        receive: { usdc: q.amountOutFormatted, atLeastUsdc: fromUnits(atLeast, 6), usd: num(q.amountOutUsd), wallet: given || null, chain: "Solana", mint: USDC_MAINNET },
        refundTo: ownRefund,
        estimatedSeconds: num(q.timeEstimate),
        deadline: dry ? null : (q.deadline ?? null),
        status: dry ? null : `/v1/topup/status/${q.depositAddress}`,
        via: "Aurora Intents",
      };
      if (dry) remember(dryCache, cacheKey, value);
      return value;
    },

    async status(depositAddress: string, visitor = "local"): Promise<TopupStatus> {
      await perVisitor("status", visitor);
      const address = depositAddress.trim();
      if (!/^[A-Za-z0-9]{20,100}$/.test(address)) throw new TopupError("that is not a deposit address from POST /v1/topup/quote", 400);
      const hit = fresh(statusCache, address, TOPUP_LIMITS.statusCacheMs);
      if (hit) return hit;

      await budget("status");
      const { status, json } = await call(`/api/status/${encodeURIComponent(opts.appKey)}?depositAddress=${encodeURIComponent(address)}`);
      const message = typeof json?.message === "string" ? json.message : "";
      if (status === 429) throw new TopupError("Aurora Intents is busy; try again in a minute", 503);
      keyRefused(status, message);
      if (/not found/i.test(message) || json?.statusCode === 404) throw new TopupError("no deposit with that address; addresses come from POST /v1/topup/quote", 404);
      if (status >= 400 && status < 500) throw new TopupError(`Aurora Intents refused this status check: ${message || `HTTP ${status}`}`, 400);
      const state = typeof json?.status === "string" ? json.status : "";
      if (status !== 200 || !state) throw new TopupError("Aurora Intents did not answer the status check. Your deposit is not affected; try again in a moment.", 502);

      const d = (json?.swapDetails ?? {}) as AuroraSwap;
      const originAsset = (json?.quoteResponse as { quoteRequest?: { originAsset?: string } } | undefined)?.quoteRequest?.originAsset;
      const origin = TOPUP_SOURCES.find((s) => s.assetId === originAsset);
      const refunded = d.refundedAmount && d.refundedAmount !== "0" ? { amount: d.refundedAmountFormatted ?? d.refundedAmount, reason: d.refundReason ?? null } : null;
      const value: TopupStatus = {
        depositAddress: address,
        status: state,
        done: DONE.has(state),
        message: (MESSAGES[state] ?? (() => `Status: ${state}.`))(d),
        updatedAt: typeof json?.updatedAt === "string" ? json.updatedAt : null,
        deposited: d.depositedAmountFormatted ?? null,
        received: state === "SUCCESS" && d.amountOutFormatted ? { usdc: d.amountOutFormatted, usd: num(d.amountOutUsd) } : null,
        refunded,
        originTxs: txs(d.originChainTxHashes, origin?.tx),
        solanaTxs: txs(d.destinationChainTxHashes, SOLANA_TX),
        via: "Aurora Intents",
      };
      remember(statusCache, address, value);
      return value;
    },
  };
}

export const TOPUP_ROUTES = ["GET /v1/topup", "POST /v1/topup/quote", "GET /v1/topup/status/:address"];

export const visitorOf = (c: Context) => c.req.header("cf-connecting-ip") ?? "local";

/** Free routes. The service applies each visitor's hourly allowance and the key's overall budget. */
export function mountTopup(app: Hono, opts: { service: TopupService }) {
  const reply = async <T>(c: Context, work: () => Promise<T>) => {
    try {
      return c.json(await work());
    } catch (e) {
      if (e instanceof TopupError) return c.json({ error: e.message, ...e.extra }, e.status);
      throw e;
    }
  };

  app.get("/v1/topup", (c) => c.json(opts.service.about()));

  app.post("/v1/topup/quote", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: 'send JSON such as {"from":"bsc-usdt","amount":"0.5","wallet":"<Solana address>","refundTo":"0x..."}' }, 400);
    return reply(c, () => opts.service.quote(body, visitorOf(c)));
  });

  app.get("/v1/topup/status/:address", (c) => reply(c, () => opts.service.status(c.req.param("address"), visitorOf(c))));
}
