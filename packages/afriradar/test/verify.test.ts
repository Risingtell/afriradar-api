// The rule `afriradar verify` enforces: every settled ledger row is on chain, paid to the treasury,
// for exactly the amount listed. Driven by a fake API and a fake JSON-RPC node.
import { describe, expect, it } from "vitest";
import { verify } from "../src/verify.js";

const TREASURY = "Treasury1111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";

function world(ledger: { tx: string; amount: number }[], chain: Record<string, number>, maxBatch = Infinity) {
  let batches = 0;
  const tx = (amount: number) => ({
    slot: 1,
    blockTime: 1_790_000_000,
    meta: { err: null, preTokenBalances: [{ owner: TREASURY, mint: MINT, uiTokenAmount: { amount: "100" } }], postTokenBalances: [{ owner: TREASURY, mint: MINT, uiTokenAmount: { amount: String(100 + amount) } }] },
  });
  const rpc = (m: { id: number; method: string; params: unknown[] }) => {
    if (m.method === "getTokenAccountsByOwner") return { jsonrpc: "2.0", id: m.id, result: { value: [{ pubkey: "TreasuryUsdcAccount" }] } };
    if (m.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: m.id, result: Object.keys(chain).map((signature) => ({ signature, err: null })) };
    if (m.method === "getTransaction") return { jsonrpc: "2.0", id: m.id, result: tx(chain[m.params[0] as string]) };
    return { jsonrpc: "2.0", id: m.id, error: { message: `unexpected ${m.method}` } };
  };
  const fake = (async (url: string, init?: RequestInit) => {
    if (url === "https://api.test/v1") return Response.json({ payTo: TREASURY, asset: { mint: MINT } });
    if (url.startsWith("https://api.test/v1/payments")) return Response.json({ recent: ledger.map((r) => ({ ...r, amount: String(r.amount), status: "settled" })) });
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body)) {
      if (body.length > maxBatch) return new Response("rate limited", { status: 429 });
      batches++;
      return Response.json(body.map(rpc).reverse()); // replies may come back in any order
    }
    return Response.json(rpc(body));
  }) as unknown as typeof fetch;
  return { fake, batches: () => batches };
}

describe("verify", () => {
  it("passes when every ledger row is on chain for the exact amount, and allows unlisted receipts", async () => {
    const w = world([{ tx: "a", amount: 1000 }, { tx: "b", amount: 2000 }], { a: 1000, b: 2000, c: 5000 });
    const seen: number[] = [];
    const r = await verify({ baseUrl: "https://api.test", rpcUrl: "https://rpc.test", fetch: w.fake, batchSize: 2, onProgress: (done) => seen.push(done) });
    expect(r).toMatchObject({ ok: true, matched: 2, missing: [], chain: { receipts: 3, usdc: 0.008 }, ledger: { settled: 2, usdc: 0.003 } });
    expect(r.unlisted.map((u) => u.tx)).toEqual(["c"]);
    expect(w.batches()).toBe(2); // three transactions in batches of two
    expect(seen).toEqual([2, 3]);
  });

  it("fails when a ledger row claims more than the chain shows", async () => {
    const w = world([{ tx: "a", amount: 1000 }, { tx: "b", amount: 9999 }], { a: 1000, b: 2000 });
    const r = await verify({ baseUrl: "https://api.test", rpcUrl: "https://rpc.test", fetch: w.fake });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([{ tx: "b", ledgerAmount: 9999, chainAmount: 2000 }]);
  });

  it("halves the batch when a node rate-limits it, and still finishes", async () => {
    const chain = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`t${i}`, 1000]));
    const w = world(Object.keys(chain).map((tx) => ({ tx, amount: 1000 })), chain, 2);
    const r = await verify({ baseUrl: "https://api.test", rpcUrl: "https://rpc.test", fetch: w.fake, batchSize: 8 });
    expect(r).toMatchObject({ ok: true, matched: 7 });
  }, 20_000);

  it("checks only the latest rows in the quick check", async () => {
    const { verifyRecent } = await import("../src/verify.js");
    const w = world([{ tx: "new", amount: 1000 }, { tx: "bad", amount: 7 }, { tx: "old", amount: 3000 }], { new: 1000, bad: 2000, old: 3000 });
    const r = await verifyRecent({ baseUrl: "https://api.test", rpcUrl: "https://rpc.test", fetch: w.fake, count: 2 });
    expect(r).toMatchObject({ checked: 2, matched: 1, ok: false, missing: [{ tx: "bad", ledgerAmount: 7, chainAmount: 2000 }] });
  });

  it("recounts mainnet from mainnet rows and the mainnet USDC mint the API declares", async () => {
    const w = world([{ tx: "m", amount: 1000 }], { m: 1000 });
    const asked: string[] = [];
    const twoNetworks = (async (url: string, init?: RequestInit) => {
      asked.push(url);
      if (url === "https://api.test/v1") return Response.json({ payTo: TREASURY, asset: { mint: "DevnetMint" }, networks: [{ id: "devnet", asset: { mint: "DevnetMint" } }, { id: "mainnet", asset: { mint: MINT } }] });
      return w.fake(url, init);
    }) as unknown as typeof fetch;
    const r = await verify({ baseUrl: "https://api.test", network: "mainnet", rpcUrl: "https://rpc.test", fetch: twoNetworks });
    expect(r).toMatchObject({ network: "mainnet", ok: true, matched: 1 });
    expect(asked.filter((u) => u.includes("/v1/payments")).every((u) => u.endsWith("&network=mainnet"))).toBe(true);
    await expect(verify({ baseUrl: "https://api.test", network: "mainnet", rpcUrl: "https://rpc.test", fetch: w.fake })).rejects.toThrow(/does not sell on mainnet/);
  });

  it("fails when a ledger row is not on chain at all", async () => {
    const w = world([{ tx: "ghost", amount: 1000 }], { a: 1000 });
    const r = await verify({ baseUrl: "https://api.test", rpcUrl: "https://rpc.test", fetch: w.fake });
    expect(r.missing).toEqual([{ tx: "ghost", ledgerAmount: 1000, chainAmount: null }]);
  });
});
