// Topping up a Solana wallet from other chains through Aurora Intents. Aurora is a fake here, replaying
// the shapes of real replies captured on 7 November 2026: nothing in this file reaches the network.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, SupportedResponse } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { InMemoryPaymentChannelStorage, UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { createApp } from "../src/app.js";
import { NETWORK } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import { AURORA_API, TOPUP_LIMITS, TOPUP_SOURCES, fromUnits, SOLANA_USDC, toUnits } from "../src/topup.js";
import { loadedDb } from "./helpers.js";

const RPC = "http://127.0.0.1:9";
const TREASURY = "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8";
const WALLET = "G7WsMPkafUc7gfbkwGyHfKWLhWgsZB46o7pBiFjpt2nN";
const EVM = "0x3f1c0a5bd2b7fd0a0b4e8e2b8c9ae5c1f2d3e4a5";
const DEPOSIT = "0x9b8d4c2e1f0a3b5c7d9e1f2a4b6c8d0e2f4a6b8c";
const START = new Date("2026-11-07T16:00:00Z").getTime();
const asset = (id: string) => TOPUP_SOURCES.find((s) => s.id === id)!.assetId;

let db: Db;
let clock = START;
let calls: { url: string; body: Record<string, unknown> | null }[] = [];
let replies: (() => Response | Promise<Response>)[] = [];
let app: Awaited<ReturnType<typeof createApp>>;

const aurora = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
  const next = replies.shift();
  if (!next) throw new Error(`unexpected Aurora call ${String(input)}`);
  return next();
}) as typeof fetch;
const reply = (status: number, json?: unknown) => () => new Response(json === undefined ? "" : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
const QUOTE = (quote: Record<string, unknown> = {}) => ({
  timestamp: "2026-11-07T16:00:00.000Z", signature: "ed25519:test", correlationId: "c-1", quoteRequest: {},
  quote: {
    timeEstimate: 34, deadline: "2026-11-10T16:00:00.000Z", timeWhenInactive: "2026-11-10T16:00:00.000Z", depositAddress: DEPOSIT,
    amountIn: "500000000000000000", amountInFormatted: "0.5", amountInUsd: "0.4996", minAmountIn: "500000000000000000",
    amountOut: "489268", amountOutFormatted: "0.489268", amountOutUsd: "0.4891", minAmountOut: "484348", refundFee: "0", withdrawFee: "0",
    ...quote,
  },
});
const STATUS = (status: string, swapDetails: Record<string, unknown> = {}) => ({ correlationId: "c-2", quoteResponse: {}, status, updatedAt: "2026-11-07T16:01:00.000Z", swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], refundedAmount: "0", ...swapDetails } });

async function build(withAurora = true) {
  const feePayer = await generateKeyPairSigner();
  const svm = toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: RPC });
  const networks = [NETWORK] as Network[];
  const facilitator = new x402Facilitator()
    .register(networks, new ExactFacilitator(svm))
    .register(networks, new UptoFacilitator(svm, { channelStorage: new InMemoryPaymentChannelStorage() }));
  const client: FacilitatorClient = { verify: (p, r) => facilitator.verify(p, r), settle: (p, r) => facilitator.settle(p, r), getSupported: async () => facilitator.getSupported() as SupportedResponse };
  return createApp({
    db,
    facilitator: client,
    llm: async () => { throw new Error("no AI in these tests"); },
    treasury: TREASURY,
    authorizer: await generateKeyPairSigner(),
    rpcUrl: RPC,
    readChain: async () => { throw new Error("no chain in these tests"); },
    now: () => new Date(clock),
    aurora: withAurora ? { appKey: "test-key", fetch: aurora } : undefined,
  });
}

const call = async (path: string, init?: RequestInit, on = app) => {
  const res = await on.fetch(new Request(`https://api.afriradar.com${path}`, init));
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
};
let ip = 0;
const quote = (body: unknown, visitor = `10.0.0.${++ip}`) => call("/v1/topup/quote", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": visitor }, body: JSON.stringify(body) });
const mcp = (message: object) => call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });

beforeAll(async () => {
  db = await loadedDb();
  app = await build();
});
beforeEach(() => {
  calls = [];
  replies = [];
  clock += 60_000; // past the status cache between tests
});

describe("amounts", () => {
  it("converts decimal strings to base units and back exactly", () => {
    expect(toUnits("0.5", 18)).toBe(500_000_000_000_000_000n);
    expect(toUnits("2.647741", 6)).toBe(2_647_741n);
    expect(toUnits("10", 9)).toBe(10_000_000_000n);
    for (const bad of ["", "-1", "1e-7", "abc", "0.1234567", ".5", "01"]) expect(toUnits(bad, 6)).toBeNull();
    expect(fromUnits(2_647_741n, 6)).toBe("2.647741");
    expect(fromUnits(238_864n, 6)).toBe("0.238864");
    expect(fromUnits(1_002_173n, 9)).toBe("0.001002173");
    expect(fromUnits(3_000_000n, 6)).toBe("3");
  });
});

describe("top up from any chain", () => {
  it("is listed among the free routes and explains itself", async () => {
    const cat = await call("/v1");
    expect(cat.body.free).toEqual(expect.arrayContaining(["GET /v1/topup", "POST /v1/topup/quote", "GET /v1/topup/status/:address"]));
    expect(cat.body.topup).toMatch(/Aurora Intents/);
    const info = await call("/v1/topup");
    expect(info.status).toBe(200);
    expect(info.body.sources.map((s: { id: string }) => s.id)).toEqual(["bsc-usdt", "tron-usdt", "base-usdc", "arb-usdc", "pol-usdt", "sol", "sol-usdt"]);
    expect(info.body.sources.map((s: { kind: string }) => s.kind)).toEqual(["evm", "tron", "evm", "evm", "evm", "solana", "solana"]);
    expect(info.body.receive).toEqual({ token: "USDC", chain: "Solana", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
    expect(calls).toHaveLength(0);
  });

  it("asks Aurora for USDC on Solana to the buyer's own wallet and returns the deposit address", async () => {
    replies.push(reply(200, QUOTE()));
    const r = await quote({ from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${AURORA_API}/api/quote/test-key`);
    expect(calls[0].body).toEqual({
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: asset("bsc-usdt"), depositType: "ORIGIN_CHAIN",
      destinationAsset: SOLANA_USDC, amount: "500000000000000000", refundTo: EVM, refundType: "ORIGIN_CHAIN", recipient: WALLET,
      recipientType: "DESTINATION_CHAIN", deadline: new Date(clock + TOPUP_LIMITS.quoteMinutes * 60_000).toISOString(),
    });
    expect(r.body.send).toEqual({ amount: "0.5", token: "USDT", chain: "BNB Smart Chain", to: DEPOSIT, memo: null, usd: 0.4996 });
    expect(r.body.receive).toMatchObject({ usdc: "0.489268", atLeastUsdc: "0.484348", wallet: WALLET, chain: "Solana" });
    expect(r.body).toMatchObject({ dry: false, refundTo: EVM, estimatedSeconds: 34, deadline: "2026-11-10T16:00:00.000Z", status: `/v1/topup/status/${DEPOSIT}`, via: "Aurora Intents" });
    expect(JSON.stringify(r.body)).not.toContain("test-key");
  });

  it("tells the buyer the route's minimum in the token they hold", async () => {
    replies.push(reply(400, { message: "Amount is too low for bridge, try at least 2647741", error: "Bad Request", statusCode: 400 }));
    const r = await quote({ from: "tron-usdt", amount: "0.5", wallet: WALLET, refundTo: "TTvz7QmSxFRwUMJfiz7CC3KuHEQo9hFXJN" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ minimum: "2.647741", token: "USDT" });
    expect(r.body.error).toMatch(/at least 2\.647741 USDT/);
  });

  it("passes Aurora's own refusal through, without a 5xx", async () => {
    replies.push(reply(400, { message: "refundTo is not valid", error: "Bad Request", statusCode: 400 }));
    const r = await quote({ from: "base-usdc", amount: "1", wallet: WALLET, refundTo: EVM });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Aurora Intents refused this quote: refundTo is not valid");
  });

  it("refuses bad input before calling Aurora", async () => {
    const good = { from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...good, from: "eth-usdt" }, /from must be one of bsc-usdt/],
      [{ ...good, amount: "0" }, /positive number/],
      [{ ...good, amount: "-1" }, /positive number/],
      [{ ...good, amount: "lots" }, /positive number/],
      [{ ...good, from: "base-usdc", amount: "0.1234567" }, /at most 6 decimal places/],
      [{ ...good, amount: "5000" }, /at most 1000 USDT/],
      [{ ...good, wallet: "not-a-wallet" }, /wallet must be the Solana address/],
      [{ ...good, wallet: undefined }, /wallet must be the Solana address/],
      [{ ...good, refundTo: undefined }, /refundTo is required: your own BNB Smart Chain address/],
      [{ ...good, refundTo: "TTvz7QmSxFRwUMJfiz7CC3KuHEQo9hFXJN" }, /refundTo must be a BNB Smart Chain address/],
      [{ ...good, from: "tron-usdt", refundTo: EVM }, /refundTo must be a Tron address/],
    ];
    for (const [body, error] of cases) {
      const r = await quote(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatch(error);
    }
    expect((await call("/v1/topup/quote", { method: "POST", headers: { "content-type": "application/json" }, body: "[1]" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refunds a Solana source to the buyer's own wallet unless told otherwise", async () => {
    replies.push(reply(200, QUOTE({ amountIn: "2000000", amountInFormatted: "0.002", depositAddress: "H1kgGxdXghVYwF6Ap4tY2muJXUijjFCpoyicmmbGRKkb" })));
    const r = await quote({ from: "sol", amount: 0.002, wallet: WALLET });
    expect(r.status).toBe(200);
    expect(calls[0].body).toMatchObject({ originAsset: "nep141:sol.omft.near", amount: "2000000", refundTo: WALLET, recipient: WALLET });
    expect(r.body.refundTo).toBe(WALLET);
  });

  it("prices a dry quote before any address is typed, and creates no deposit address", async () => {
    const { depositAddress: _, deadline: __, ...dryQuote } = QUOTE().quote;
    replies.push(reply(200, { ...QUOTE(), quote: dryQuote }));
    const r = await quote({ from: "bsc-usdt", amount: "0.5", dry: true });
    expect(r.status).toBe(200);
    expect(calls[0].body).toMatchObject({ dry: true, recipient: TREASURY, refundTo: "0x59bac2bf558394b5c54c6e2b203054e24dd4f42f" });
    expect(r.body).toMatchObject({ dry: true, refundTo: null, deadline: null, status: null });
    expect(r.body.send.to).toBeNull();
    expect(r.body.receive).toMatchObject({ usdc: "0.489268", wallet: null });
  });

  it("says no address was created when Aurora does not answer", async () => {
    replies.push(reply(200), reply(500, { message: "Internal server error" }), () => { throw new TypeError("fetch failed"); }, reply(200, { quote: {} }));
    for (let i = 0; i < 4; i++) {
      const r = await quote({ from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM });
      expect(r.status).toBe(502);
      expect(r.body.error).toMatch(/no deposit address was created/);
    }
    expect(calls).toHaveLength(4);
  });

  it("treats a non-dry quote without a deposit address as a failure", async () => {
    const { depositAddress: _, ...noAddress } = QUOTE().quote;
    replies.push(reply(200, { ...QUOTE(), quote: noAddress }));
    expect((await quote({ from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM })).status).toBe(502);
  });

  it("tracks a deposit until the USDC lands, with both chains' transactions", async () => {
    replies.push(reply(200, STATUS("PENDING_DEPOSIT")));
    const waiting = await call(`/v1/topup/status/${DEPOSIT}`);
    expect(calls[0].url).toBe(`${AURORA_API}/api/status/test-key?depositAddress=${DEPOSIT}`);
    expect(waiting.body).toMatchObject({ status: "PENDING_DEPOSIT", done: false, message: "Waiting for your deposit.", received: null, refunded: null });

    clock += TOPUP_LIMITS.statusCacheMs + 1;
    replies.push(reply(200, STATUS("SUCCESS", {
      amountInFormatted: "0.5", amountOutFormatted: "0.489268", amountOutUsd: "0.4891",
      originChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://bscscan.com/tx/0xabc" }],
      destinationChainTxHashes: [{ hash: "5Sol", explorerUrl: "https://solscan.io/tx/5Sol" }],
    })));
    const done = await call(`/v1/topup/status/${DEPOSIT}`);
    expect(done.body).toMatchObject({
      status: "SUCCESS", done: true, message: "Done: 0.489268 USDC arrived in your Solana wallet.",
      received: { usdc: "0.489268", usd: 0.4891 },
      originTxs: [{ hash: "0xabc", explorer: "https://bscscan.com/tx/0xabc" }],
      solanaTxs: [{ hash: "5Sol", explorer: "https://solscan.io/tx/5Sol" }],
    });
    expect(JSON.stringify(done.body)).not.toContain("test-key");
  });

  it("builds explorer links when Aurora sends hashes without them, as it did for the first live top-up", async () => {
    replies.push(reply(200, {
      ...STATUS("SUCCESS", {
        amountOutFormatted: "0.209926", amountOutUsd: "0.2098",
        originChainTxHashes: [{ hash: "0x1ba28fa61b82e4bb0fa783b268f27a4074b6c458088a3841a0b17685fed71c1c", explorerUrl: "" }],
        destinationChainTxHashes: [{ hash: "xrK4ZtUVrAgSiA8BrWcum3s98yEZFU3YhxcJFxDtULM5Nuyry2YFWxK7bQoxr8WpfXLS4DzS7C66MkPdXjZFLVT", explorerUrl: "" }],
      }),
      quoteResponse: { quoteRequest: { originAsset: asset("base-usdc"), destinationAsset: SOLANA_USDC } },
    }));
    const r = await call("/v1/topup/status/0xD1cFC3988d179308015e62dC912ea25E58f4E73c");
    expect(r.body.originTxs).toEqual([{ hash: "0x1ba28fa61b82e4bb0fa783b268f27a4074b6c458088a3841a0b17685fed71c1c", explorer: "https://basescan.org/tx/0x1ba28fa61b82e4bb0fa783b268f27a4074b6c458088a3841a0b17685fed71c1c" }]);
    expect(r.body.solanaTxs).toEqual([{ hash: "xrK4ZtUVrAgSiA8BrWcum3s98yEZFU3YhxcJFxDtULM5Nuyry2YFWxK7bQoxr8WpfXLS4DzS7C66MkPdXjZFLVT", explorer: "https://explorer.solana.com/tx/xrK4ZtUVrAgSiA8BrWcum3s98yEZFU3YhxcJFxDtULM5Nuyry2YFWxK7bQoxr8WpfXLS4DzS7C66MkPdXjZFLVT" }]);
    expect(r.body.message).toBe("Done: 0.209926 USDC arrived in your Solana wallet.");
  });

  it("reports a refund with its reason", async () => {
    replies.push(reply(200, STATUS("REFUNDED", { refundedAmount: "500000000000000000", refundedAmountFormatted: "0.5", refundReason: "deadline passed" })));
    const r = await call(`/v1/topup/status/${DEPOSIT}`);
    expect(r.body).toMatchObject({ done: true, refunded: { amount: "0.5", reason: "deadline passed" }, message: "Refunded 0.5 to your refund address: deadline passed." });
  });

  it("answers repeated status checks within a few seconds from a cache", async () => {
    replies.push(reply(200, STATUS("PROCESSING")));
    await call(`/v1/topup/status/${DEPOSIT}`);
    const again = await call(`/v1/topup/status/${DEPOSIT}`);
    expect(again.body.status).toBe("PROCESSING");
    expect(calls).toHaveLength(1);
  });

  it("returns 404 for an address Aurora does not know, and 400 for one that cannot be an address", async () => {
    replies.push(reply(400, { message: "Deposit address 0xe4023d5137f67f49969c0505d2ab4d747f4399ab not found", error: "Not Found", statusCode: 404 }));
    expect((await call("/v1/topup/status/0xe4023d5137f67f49969c0505d2ab4d747f4399ab")).status).toBe(404);
    expect((await call("/v1/topup/status/short")).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("limits each visitor's quotes per hour, so nobody can spend the key's quota", async () => {
    for (let i = 0; i < TOPUP_LIMITS.quotesPerVisitorHour; i++) expect((await quote({ from: "nope" }, "10.9.9.9")).status).toBe(400);
    const r = await quote({ from: "nope" }, "10.9.9.9");
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/deposit addresses an hour per visitor/);
    expect(calls).toHaveLength(0);
    // Price checks have their own allowance, so a visitor who used up deposit addresses can still see prices.
    expect((await quote({ from: "nope", dry: true }, "10.9.9.9")).status).toBe(400);
  });

  it("shares each visitor's allowance between the HTTP routes and the MCP tools", async () => {
    for (let i = 0; i < TOPUP_LIMITS.quotesPerVisitorHour; i++) await quote({ from: "nope" }, "10.8.8.8");
    const viaMcp = await call("/mcp", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "10.8.8.8" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "afriradar_topup_quote", arguments: { from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM } } }) });
    expect(viaMcp.body.result.isError).toBe(true);
    expect(viaMcp.body.result.structuredContent).toMatchObject({ status: 429, retryLater: true });
    expect(calls).toHaveLength(0);
  });

  it("answers the same price check from a short cache", async () => {
    replies.push(reply(200, { ...QUOTE(), quote: { ...QUOTE().quote, depositAddress: undefined } }));
    const first = await quote({ from: "arb-usdc", amount: "0.75", dry: true });
    const again = await quote({ from: "arb-usdc", amount: "0.75", dry: true });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body).toEqual(first.body);
    expect(calls).toHaveLength(1);
  });

  it("never reports a stand-in address as the buyer's refund address", async () => {
    replies.push(reply(200, { ...QUOTE(), quote: { ...QUOTE().quote, depositAddress: undefined } }));
    const r = await quote({ from: "sol", amount: "0.01", dry: true });
    expect(calls[0].body).toMatchObject({ recipient: TREASURY, refundTo: TREASURY });
    expect(r.body.refundTo).toBeNull();
    expect(r.body.receive.wallet).toBeNull();
  });

  it("treats an unreadable amount from Aurora as no answer, not a crash", async () => {
    replies.push(reply(200, QUOTE({ minAmountOut: "484348.0" })));
    const r = await quote({ from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM });
    expect(r.status).toBe(502);
  });

  it("reports a refused app key as our outage, not the buyer's mistake", async () => {
    replies.push(reply(401, { message: "Unauthorized", statusCode: 401 }), reply(403, { message: "Forbidden", statusCode: 403 }));
    const q = await quote({ from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM });
    expect(q.status).toBe(503);
    expect(q.body.error).toMatch(/unavailable right now/);
    expect((await call(`/v1/topup/status/${DEPOSIT}`)).status).toBe(503);
  });

  it("is switched off without an Aurora key", async () => {
    const plain = await build(false);
    expect((await call("/v1/topup", undefined, plain)).status).toBe(404);
    expect((await call("/v1", undefined, plain)).body.free).not.toContain("POST /v1/topup/quote");
    const tools = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, plain);
    expect((tools.body.result.tools as { name: string }[]).map((t) => t.name)).not.toContain("afriradar_topup_quote");
  });

  it("gives agents the same top-up as free MCP tools", async () => {
    const list = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (list.body.result.tools as { name: string; description: string }[]).map((t) => t.name);
    expect(names.slice(-3)).toEqual(["afriradar_topup_sources", "afriradar_topup_quote", "afriradar_topup_status"]);

    replies.push(reply(200, QUOTE()));
    const ok = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "afriradar_topup_quote", arguments: { from: "bsc-usdt", amount: "0.5", wallet: WALLET, refundTo: EVM } } });
    expect(ok.body.result.isError).toBeUndefined();
    expect(ok.body.result.structuredContent).toMatchObject({ send: { to: DEPOSIT }, receive: { usdc: "0.489268" } });

    const bad = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "afriradar_topup_quote", arguments: { from: "bsc-usdt", amount: "0.5" } } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/wallet must be the Solana address/);

    // Below the minimum, an agent gets the minimum as data, not only as a sentence.
    replies.push(reply(400, { message: "Amount is too low for bridge, try at least 2647741", statusCode: 400 }));
    const low = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "afriradar_topup_quote", arguments: { from: "tron-usdt", amount: "1", dry: true } } });
    expect(low.body.result.isError).toBe(true);
    expect(low.body.result.structuredContent).toMatchObject({ minimum: "2.647741", token: "USDT", status: 400, retryLater: false });
  });
});
