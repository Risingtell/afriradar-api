// Cloudflare Worker entry. One Worker hosts the API, its x402 facilitator and the scheduled jobs.
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { SupportedResponse } from "@x402/core/types";
import type { Network } from "@x402/core/types";
import { createRpcClient, toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { workersAi } from "./agent/ask.js";
import { chainReader, createApp } from "./app.js";
import { MAINNET, NETWORK, USDC_MAINNET } from "./catalog.js";
import { d1, type Db } from "./db.js";
import { catchUp, recordRun, siteWeek } from "./data/freshness.js";
import { latestWeek } from "./data/queries.js";
import { ingest } from "./data/ingest.js";
import { ingestKenya } from "./data/kenya.js";
import { D1ChannelStorage, D1PendingStore } from "./facilitator/storage.js";
import { kindsAt, runMonitor } from "./monitor.js";
import { jsonRpc } from "./reconcile.js";
import { feeGuard, LOCK_WAIT, solUsdReader, UPTO_OPEN_LIMITS } from "./netfee.js";
import { sweepCounters } from "./limits.js";
import { payerLock, sweepPayerLocks } from "./payerlock.js";
import { watchingRefusals } from "./sends.js";

export type Env = {
  DB: Parameters<typeof d1>[0];
  AI: { run: (model: string, input: object) => Promise<unknown> };
  FACILITATOR_KEY: string; // JSON byte array, devnet fee payer
  AUTHORIZER_KEY: string; // JSON byte array, signs upto claim vouchers
  DEMO_BUYER_KEY?: string; // JSON byte array, funded devnet wallet for the no-wallet demo
  TREASURY: string; // payTo address
  RPC_URL: string; // Solana devnet
  /** Solana mainnet. When set, every paid route also accepts real USDC on mainnet; same keys, same treasury. */
  MAINNET_RPC_URL?: string;
  DATA_BASE_URL: string; // https://afriradar.com
  AI_MODEL?: string;
  /** Aurora Intents key from studio.aurora.dev: turns on /v1/topup. Aurora says it is not secret; kept as a secret anyway. */
  AURORA_APP_KEY?: string;
};

const MONITOR_CRON = "41 * * * *"; // wrangler.toml [triggers]
const signerFrom = (json: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(json)));

type Built = { app: Awaited<ReturnType<typeof createApp>>; upto: UptoFacilitator; db: Db; demoSigner?: KeyPairSigner; networks: Network[] };
let built: Promise<Built> | undefined;

async function build(env: Env): Promise<Built> {
  const db = d1(env.DB);
  const [feePayer, authorizer]: KeyPairSigner[] = await Promise.all([signerFrom(env.FACILITATOR_KEY), signerFrom(env.AUTHORIZER_KEY)]);
  const networks = [NETWORK, ...(env.MAINNET_RPC_URL ? [MAINNET] : [])] as Network[];
  // One fee payer on both networks, each read and sent through its own RPC.
  const signer = toFacilitatorSvmSigner(feePayer, {
    [NETWORK]: createRpcClient(NETWORK as Network, env.RPC_URL),
    ...(env.MAINNET_RPC_URL ? { [MAINNET]: createRpcClient(MAINNET as Network, env.MAINNET_RPC_URL) } : {}),
  });
  // The sends the RPC refused in the last two minutes, by transaction fingerprint, for the payer lock.
  const refusedSends = new Map<string, number>();
  const svm = watchingRefusals(signer, refusedSends);
  const upto = new UptoFacilitator(svm, {
    channelStorage: new D1ChannelStorage(db),
    pendingSettlementStore: new D1PendingStore(db),
    maxChannelLifetimeSecs: 3600,
    // Loose per-field bounds on the buyer-built channel open; feeGuard below enforces its exact fee.
    ...UPTO_OPEN_LIMITS,
  });
  const facilitator = new x402Facilitator().register(networks, new ExactFacilitator(svm)).register(networks, upto);
  // In-process: the resource server calls the facilitator directly, no HTTP hop. On mainnet the
  // guard refuses, before we sign, any payment whose transaction costs more in fees than its price
  // covers, and sends one account's payments one at a time (payerLock), so a buyer cannot make
  // several of its own payments fail on chain at our cost.
  const client = feeGuard({
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  }, MAINNET, payerLock(db), LOCK_WAIT, (fp) => refusedSends.has(fp));
  const demoSigner = env.DEMO_BUYER_KEY ? await signerFrom(env.DEMO_BUYER_KEY) : undefined;
  const app = await createApp({
    db,
    facilitator: client,
    landed: client.landed,
    llm: workersAi(env.AI, env.AI_MODEL),
    treasury: env.TREASURY,
    authorizer,
    rpcUrl: env.RPC_URL,
    readChain: chainReader(jsonRpc(env.RPC_URL), env.TREASURY),
    mainnet: env.MAINNET_RPC_URL
      ? { rpcUrl: env.MAINNET_RPC_URL, readChain: chainReader(jsonRpc(env.MAINNET_RPC_URL), env.TREASURY, USDC_MAINNET), solUsd: solUsdReader(jsonRpc(env.MAINNET_RPC_URL)) }
      : undefined,
    demoSigner,
    feePayer,
    aurora: env.AURORA_APP_KEY ? { appKey: env.AURORA_APP_KEY } : undefined,
    siteWeek: () => siteWeek(env.DATA_BASE_URL),
  });
  return { app, upto, db, demoSigner, networks };
}

const get = (env: Env) => (built ??= build(env).catch((e) => {
  built = undefined; // a failed boot (bad secret, RPC down) must not stick for the isolate's lifetime
  throw e;
}));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { app } = await get(env);
    return app.fetch(req, env, ctx);
  },

  // Hourly: the end-to-end payment monitor, and on mainnet the return of payment-channel rent, so the
  // facilitator's SOL is never held for long. Daily: pull the latest SEC week and the Kenya history
  // from AfriRadar, then close and reclaim abandoned devnet payment channels.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { app, upto, db, demoSigner, networks } = await get(env);
    const cleanup = (network: Network) =>
      upto.createRentCleanupManager(network).cleanup()
        .then(() => console.log("rent cleanup done", network))
        .catch((e) => console.error("rent cleanup failed", network, e));
    if (event.cron === MONITOR_CRON) {
      // Hourly: pick up a new SEC week as soon as the website has it (src/data/freshness.ts).
      ctx.waitUntil(
        catchUp(db, { baseUrl: env.DATA_BASE_URL })
          .then((r) => (r.ingested || r.skipped || (r.site && r.api && r.site > r.api) ? console.log("catch-up", JSON.stringify(r)) : undefined))
          .catch((e) => console.error("catch-up failed", e)),
      );
      if (networks.includes(MAINNET as Network)) ctx.waitUntil(cleanup(MAINNET as Network));
      if (!demoSigner) return;
      const now = new Date(event.scheduledTime);
      ctx.waitUntil(
        runMonitor({ app, db, signer: demoSigner, rpcUrl: env.RPC_URL, now: () => new Date(), kinds: kindsAt(now) })
          .then((r) => console.log("monitor", JSON.stringify(r)))
          .catch((e) => console.error("monitor failed", e)),
      );
      return;
    }
    ctx.waitUntil(
      (async () => {
        const at = new Date(event.scheduledTime);
        try {
          const r = await ingest(db, { baseUrl: env.DATA_BASE_URL });
          console.log("ingest", r.changed, "rows written", JSON.stringify(r.map((x) => [x.category, x.rows, x.weeks.at(-1)])));
          await recordRun(db, { at, kind: "daily", site: null, api: await latestWeek(db), changed: r.changed });
        } catch (e) {
          console.error("ingest failed", e);
          await recordRun(db, { at, kind: "daily", site: null, api: null, changed: 0, error: String((e as Error).message ?? e).slice(0, 300) }).catch(() => undefined);
        }
        try {
          const k = await ingestKenya(db, { baseUrl: env.DATA_BASE_URL });
          console.log("kenya ingest", k.changed, "rows written of", k.rows, k.quarters.at(-1));
        } catch (e) {
          console.error("kenya ingest failed", e); // Nigeria above is already stored; Kenya retries tomorrow
        }
        await sweepPayerLocks(db, at.getTime()).catch((e) => console.error("payer lock sweep failed", e));
        await sweepCounters(db, at).catch((e) => console.error("rate-limit counter sweep failed", e));
        await cleanup(NETWORK as Network);
      })(),
    );
  },
};
