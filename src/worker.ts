// Cloudflare Worker entry. One Worker hosts the API, its x402 facilitator and the scheduled jobs.
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import type { Network } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { workersAi } from "./agent/ask.js";
import { chainReader, createApp } from "./app.js";
import { NETWORK } from "./catalog.js";
import { d1, type Db } from "./db.js";
import { ingest } from "./data/ingest.js";
import { D1ChannelStorage, D1PendingStore } from "./facilitator/storage.js";
import { jsonRpc } from "./reconcile.js";

export type Env = {
  DB: Parameters<typeof d1>[0];
  AI: { run: (model: string, input: object) => Promise<unknown> };
  FACILITATOR_KEY: string; // JSON byte array, devnet fee payer
  AUTHORIZER_KEY: string; // JSON byte array, signs upto claim vouchers
  DEMO_BUYER_KEY?: string; // JSON byte array, funded devnet wallet for the no-wallet demo
  TREASURY: string; // payTo address
  RPC_URL: string;
  DATA_BASE_URL: string; // https://afriradar.com
  AI_MODEL?: string;
};

const signerFrom = (json: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(json)));

type Built = { app: Awaited<ReturnType<typeof createApp>>; upto: UptoFacilitator; db: Db };
let built: Promise<Built> | undefined;

async function build(env: Env): Promise<Built> {
  const db = d1(env.DB);
  const [feePayer, authorizer]: KeyPairSigner[] = await Promise.all([signerFrom(env.FACILITATOR_KEY), signerFrom(env.AUTHORIZER_KEY)]);
  const svm = toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: env.RPC_URL });
  const upto = new UptoFacilitator(svm, {
    channelStorage: new D1ChannelStorage(db),
    pendingSettlementStore: new D1PendingStore(db),
    maxChannelLifetimeSecs: 3600,
  });
  const facilitator = new x402Facilitator().register(NETWORK as Network, new ExactFacilitator(svm)).register(NETWORK as Network, upto);
  // In-process: the resource server calls the facilitator directly, no HTTP hop.
  const client: FacilitatorClient = {
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
  const app = await createApp({
    db,
    facilitator: client,
    llm: workersAi(env.AI, env.AI_MODEL),
    treasury: env.TREASURY,
    authorizer,
    rpcUrl: env.RPC_URL,
    readChain: chainReader(jsonRpc(env.RPC_URL), env.TREASURY),
    demoSigner: env.DEMO_BUYER_KEY ? await signerFrom(env.DEMO_BUYER_KEY) : undefined,
  });
  return { app, upto, db };
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

  // Daily: pull the latest SEC week from AfriRadar, then close and reclaim abandoned payment channels.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { upto, db } = await get(env);
    ctx.waitUntil(
      (async () => {
        try {
          const r = await ingest(db, { baseUrl: env.DATA_BASE_URL });
          console.log("ingest", JSON.stringify(r.map((x) => [x.category, x.rows, x.weeks.at(-1)])));
        } catch (e) {
          console.error("ingest failed", e);
        }
        try {
          await upto.createRentCleanupManager(NETWORK as Network).cleanup();
          console.log("rent cleanup done");
        } catch (e) {
          console.error("rent cleanup failed", e);
        }
      })(),
    );
  },
};
