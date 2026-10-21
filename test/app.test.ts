// The app's free surface: ledger totals, monitor status, the hosted MCP server, x402 discovery,
// the faucet's input checks and the RPC relay. A real in-process facilitator, no network: nothing
// here signs, settles or reads the chain.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, SupportedResponse } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { InMemoryPaymentChannelStorage, UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { createApp } from "../src/app.js";
import { NETWORK, PRODUCTS } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import { kindsAt, MONITOR, monitorStatus } from "../src/monitor.js";
import { RECORDED_ATTACK } from "../src/proof.js";
import { loadedDb } from "./helpers.js";

const RPC = "http://127.0.0.1:9"; // nothing listens: any test that reaches the network fails loudly
const NOW = new Date("2026-10-21T12:00:00Z");
let db: Db;
let demo: KeyPairSigner;
let app: Awaited<ReturnType<typeof createApp>>;

async function build(withDemo = true) {
  const feePayer = await generateKeyPairSigner();
  const svm = toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: RPC });
  const facilitator = new x402Facilitator()
    .register(NETWORK as Network, new ExactFacilitator(svm))
    .register(NETWORK as Network, new UptoFacilitator(svm, { channelStorage: new InMemoryPaymentChannelStorage() }));
  const client: FacilitatorClient = { verify: (p, r) => facilitator.verify(p, r), settle: (p, r) => facilitator.settle(p, r), getSupported: async () => facilitator.getSupported() as SupportedResponse };
  return createApp({
    db,
    facilitator: client,
    llm: async () => { throw new Error("no AI in these tests"); },
    treasury: "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8",
    authorizer: await generateKeyPairSigner(),
    rpcUrl: RPC,
    readChain: async () => { throw new Error("no chain in these tests"); },
    now: () => NOW,
    demoSigner: withDemo ? demo : undefined,
    feePayer: withDemo ? feePayer : undefined,
  });
}

const json = async (path: string, init?: RequestInit) => {
  const res = await app.fetch(new Request(`https://api.afriradar.com${path}`, init));
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any>, res };
};
const mcp = (message: object) => json("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });

beforeAll(async () => {
  db = await loadedDb();
  demo = await generateKeyPairSigner();
  app = await build();
  const row = (id: string, payer: string, amount: number, status: string, detail: string | null = null) =>
    db.run("INSERT INTO payments (id, tx, route, scheme, amount, payer, status, detail, created_at) VALUES (?, ?, '/v1/x', 'exact', ?, ?, ?, ?, ?)", id, id, String(amount), payer, status, detail, NOW.toISOString());
  await row("v1", "VisitorA", 2000, "settled");
  await row("v2", "VisitorB", 1000, "settled");
  await row("v3", "VisitorA", 5000, "settled");
  await row("d1", demo.address, 3000, "settled");
  await row("m1", demo.address, 1000, "settled", "monitor");
  await row("f1", "VisitorC", 0, "failed", "invalid_exact_svm_payload_transaction: blockhash expired");
});

describe("ledger totals", () => {
  it("counts visitors apart from the demo wallet, and the monitor apart from everyone", async () => {
    const { body } = await json("/v1/payments");
    expect(body.settled).toEqual({ payments: 4, usdc: 0.011, payers: 3 });
    expect(body.visitors).toEqual({ payments: 3, usdc: 0.008, wallets: 2 });
    expect(body.monitor).toEqual({ payments: 1 });
    const byId = Object.fromEntries((body.recent as { tx: string; demo: boolean; monitor: boolean }[]).map((r) => [r.tx, r]));
    expect([byId.d1.demo, byId.d1.monitor]).toEqual([true, false]);
    expect([byId.m1.demo, byId.m1.monitor]).toEqual([false, true]);
    expect([byId.v1.demo, byId.v1.monitor]).toEqual([false, false]);
  });

  it("keeps the facilitator's explanation on a failed row", async () => {
    const { body } = await json("/v1/payments");
    expect((body.recent as { tx: string; detail: string }[]).find((r) => r.tx === "f1")?.detail).toMatch(/blockhash expired/);
  });
});

describe("monitor status", () => {
  it("asks the analyst every sixth hour and buys data every hour", () => {
    expect(kindsAt(new Date("2026-10-21T06:41:00Z"))).toEqual(["data", "ask"]);
    expect(kindsAt(new Date("2026-10-21T07:41:00Z"))).toEqual(["data"]);
  });

  it("tallies the last day and week, newest first", async () => {
    const check = (h: number, kind: string, ok: boolean) =>
      db.run("INSERT INTO checks (id, at, kind, ok, status, ms, tx, detail) VALUES (?, ?, ?, ?, 200, 900, ?, ?)", `c${h}${kind}`, new Date(NOW.getTime() - h * 3_600_000).toISOString(), kind, ok ? 1 : 0, ok ? `tx${h}` : null, ok ? null : "HTTP 503");
    await check(1, "data", true);
    await check(2, "data", false);
    await check(30, "ask", true);
    await check(24 * 8, "data", true); // older than a week: ignored
    const s = await monitorStatus(db, NOW, (t) => `https://x/${t}`);
    expect(s.last).toMatchObject({ kind: "data", ok: true, tx: "tx1", explorer: "https://x/tx1" });
    expect(s.last24h).toEqual({ runs: 2, passed: 1 });
    expect(s.last7d).toEqual({ runs: 3, passed: 2, data: { runs: 2, passed: 1 }, ask: { runs: 1, passed: 1 } });
    expect(s.monitor).toContain(MONITOR.data);
    const { body } = await json("/v1/status");
    expect(body.last24h).toEqual({ runs: 2, passed: 1 });
    expect(body.payments7d).toEqual({ settled: 5, failed: 1 });
  });
});

describe("hosted MCP server", () => {
  it("answers the handshake in the client's protocol version", async () => {
    const { body } = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(body.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "afriradar" }, capabilities: { tools: {} } });
  });

  it("acknowledges notifications without a reply", async () => {
    const { status } = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(status).toBe(202);
  });

  it("lists free and paid tools with input schemas", async () => {
    const { body } = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (body.result.tools as { name: string; inputSchema: object }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["afriradar_search", "afriradar_overview", "afriradar_status", "afriradar_fund", "afriradar_kenya_scheme"]));
    expect(body.result.tools.every((t: { inputSchema: { type: string } }) => t.inputSchema.type === "object")).toBe(true);
  });

  it("answers a free tool directly", async () => {
    const { body } = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "afriradar_search", arguments: { query: "aiico" } } });
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.results[0].id).toBe("money-market/aiico-money-market-fund");
  });

  it("prices a paid tool with an x402 challenge instead of answering", async () => {
    const { body } = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "afriradar_fund", arguments: { id: "money-market/aiico-money-market-fund" } } });
    expect(body.result.isError).toBe(true);
    const required = body.result.structuredContent;
    expect(required.resource.url).toBe("mcp://tool/afriradar_fund");
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, amount: String(PRODUCTS.fund.price), payTo: "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8" });
    expect(required.extensions.bazaar).toBeDefined();
  });

  it("rejects an unknown tool and an unknown method", async () => {
    expect((await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })).body.error.code).toBe(-32602);
    expect((await mcp({ jsonrpc: "2.0", id: 6, method: "resources/list" })).body.error.code).toBe(-32601);
  });
});

describe("x402 discovery", () => {
  it("puts Bazaar call instructions in a paid route's 402", async () => {
    const { status, res } = await json(PRODUCTS.fund.example);
    expect(status).toBe(402);
    const required = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") as string, "base64").toString("utf8"));
    expect(required.extensions.bazaar.info.input).toMatchObject({ method: "GET", pathParams: { category: "money-market", slug: "aiico-money-market-fund" } });
  });
});

describe("faucet", () => {
  it("refuses anything that is not a wallet address, and our own wallets", async () => {
    const post = (address: string) => json("/demo/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
    expect((await post("not-an-address")).status).toBe(400);
    expect((await post(demo.address)).status).toBe(400);
  });
});

describe("live cap proof", () => {
  it("links the same attack recorded on chain by scripts/cap-proof.ts", () => {
    const doc = JSON.parse(readFileSync("docs/cap-proof.json", "utf8"));
    expect(RECORDED_ATTACK.tx).toBe(doc.attack.tx);
    expect(RECORDED_ATTACK.ceiling).toBe(doc.ceilingMicroUsdc);
  });

  it("needs the demo wallet", async () => {
    const bare = await build(false);
    const res = await bare.fetch(new Request("https://api.afriradar.com/v1/proof/cap"));
    expect(res.status).toBe(503);
  });
});

describe("RPC relay", () => {
  const rpc = (body: unknown) => json("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  it("refuses anything that writes, and oversized batches", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] })).status).toBe(400);
    expect((await rpc(Array.from({ length: 26 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getSlot" })))).status).toBe(400);
  });
});
