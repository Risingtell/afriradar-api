// Concordium Agent Registry checks for paying Solana wallets: verified only when the key binding, an Active
// agent and a matching card all hold; failures never verify and are never cached.
import { describe, expect, it } from "vitest";
import { claimMismatch } from "../src/concordium/access.js";
import { agentCheck, CHECK_TTL_MS, CONCORDIUM, lookUpAgent, registryRpc, solanaKeyHex } from "../src/concordium/registry.js";
import { readFileSync } from "node:fs";
import { MAINNET, NETWORK, PRODUCTS } from "../src/catalog.js";
import { AFRIRADAR_AGENTS, agentCard, sha256Hex } from "../src/concordium/agents.js";
import { sqlite } from "../src/sqlite.js";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const T0 = new Date("2026-11-20T10:00:00Z");

const record = (over: Record<string, unknown> = {}) => ({
  network: "testnet", token_address: "JyP9X11eGJ1sYCvZWkWg6", token_id: "1189", owner_account: "4mX6mBtX2FUgoW8hMio2hcjZsh57hcPG2gN9vTi71bYrb5FoTj",
  agent_uri: "https://api.afriradar.com/.well-known/agent-card.json", metadata_hash_hex: "ab".repeat(32), status: "Active", ...over,
});

/** A fake registry: answers per tool, and records every call. */
function fakeRpc(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const rpc = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const a = answers[tool];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? (a as (x: Record<string, unknown>) => unknown)(args) : (a ?? null);
  };
  return { rpc, calls };
}

describe("looking a paying wallet up in the Agent Registry", () => {
  it("asks for the wallet's ed25519 key under the CIS-8 registry and the Solana network it paid on", async () => {
    const { rpc, calls } = fakeRpc({ agent_by_external_reference: null });
    await lookUpAgent(WALLET, NETWORK, { rpc });
    expect(calls[0]).toEqual({
      tool: "agent_by_external_reference",
      args: {
        network: "testnet",
        external_reference: { kind: "Cis8", contract_address: CONCORDIUM.testnet.cis8, key: { namespace: NETWORK, key_type: "ed25519", public_key_hex: solanaKeyHex(WALLET) } },
      },
    });
    expect(solanaKeyHex(WALLET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies only an Active agent whose card matches its on-chain hash", async () => {
    const { rpc } = fakeRpc({ agent_by_external_reference: record(), verify_agent_card: { match: true } });
    const c = await lookUpAgent(WALLET, NETWORK, { rpc, now: T0 });
    expect(c.verified).toBe(true);
    expect(c.agent).toMatchObject({ tokenId: "1189", badge: "JyP9X11eGJ1sYCvZWkWg6", status: "Active", cardMatches: true });
  });

  it("does not verify a wallet with no agent, a revoked agent, or a card that changed", async () => {
    expect((await lookUpAgent(WALLET, NETWORK, { rpc: fakeRpc({}).rpc })).reason).toMatch(/no Concordium agent/);
    const revoked = await lookUpAgent(WALLET, NETWORK, { rpc: fakeRpc({ agent_by_external_reference: record({ status: "Revoked" }) }).rpc });
    expect(revoked).toMatchObject({ verified: false, reason: "the agent is Revoked, not Active" });
    const changed = await lookUpAgent(WALLET, NETWORK, { rpc: fakeRpc({ agent_by_external_reference: record(), verify_agent_card: { match: false } }).rpc });
    expect(changed).toMatchObject({ verified: false, reason: "the agent's card does not match its on-chain hash" });
    const unknownCard = await lookUpAgent(WALLET, NETWORK, { rpc: fakeRpc({ agent_by_external_reference: record(), verify_agent_card: { match: null } }).rpc });
    expect(unknownCard.verified).toBe(false);
  });

  it("never verifies when the registry cannot be read, and never throws", async () => {
    const c = await lookUpAgent(WALLET, NETWORK, { rpc: fakeRpc({ agent_by_external_reference: new Error("HTTP 503") }).rpc });
    expect(c).toMatchObject({ verified: false, agent: null });
    expect(c.reason).toMatch(/could not be read: HTTP 503/);
    expect((await lookUpAgent("not-an-address", NETWORK, { rpc: fakeRpc({}).rpc })).reason).toBe("not a Solana address");
  });
});

describe("the hour-long cache", () => {
  it("looks a wallet up once an hour, not once a payment", async () => {
    const db = sqlite();
    const { rpc, calls } = fakeRpc({ agent_by_external_reference: record(), verify_agent_card: { match: true } });
    expect((await agentCheck(db, WALLET, NETWORK, { rpc, now: T0 })).verified).toBe(true);
    expect((await agentCheck(db, WALLET, NETWORK, { rpc, now: new Date(T0.getTime() + CHECK_TTL_MS - 1) })).verified).toBe(true);
    expect(calls.filter((x) => x.tool === "agent_by_external_reference")).toHaveLength(1);
    await agentCheck(db, WALLET, NETWORK, { rpc, now: new Date(T0.getTime() + CHECK_TTL_MS) });
    expect(calls.filter((x) => x.tool === "agent_by_external_reference")).toHaveLength(2);
  });

  it("picks up a revocation within the hour after it happens", async () => {
    const db = sqlite();
    let status = "Active";
    const { rpc } = fakeRpc({ agent_by_external_reference: () => record({ status }), verify_agent_card: { match: true } });
    expect((await agentCheck(db, WALLET, NETWORK, { rpc, now: T0 })).verified).toBe(true);
    status = "Revoked";
    expect((await agentCheck(db, WALLET, NETWORK, { rpc, now: new Date(T0.getTime() + CHECK_TTL_MS) })).verified).toBe(false);
  });

  it("does not keep a failed lookup, so the next payment tries again", async () => {
    const db = sqlite();
    let down = true;
    const { rpc } = fakeRpc({ agent_by_external_reference: () => { if (down) throw new Error("timeout"); return record(); }, verify_agent_card: { match: true } });
    expect((await agentCheck(db, WALLET, NETWORK, { rpc, now: T0 })).verified).toBe(false);
    down = false;
    expect((await agentCheck(db, WALLET, NETWORK, { rpc, now: new Date(T0.getTime() + 1000) })).verified).toBe(true);
  });
});

describe("the registry client", () => {
  it("sends one MCP tools/call and returns the tool's JSON, or the error it reported", async () => {
    const sent: unknown[] = [];
    const ok = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"match":true}' }] } }));
    }) as unknown as typeof fetch;
    expect(await registryRpc(ok)("verify_agent_card", { token_id: "1" })).toEqual({ match: true });
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "verify_agent_card", arguments: { token_id: "1" } } });
    const toolError = (async () => new Response(JSON.stringify({ result: { isError: true, content: [{ text: "bad token" }] } }))) as unknown as typeof fetch;
    await expect(registryRpc(toolError)("agent_of", {})).rejects.toThrow(/bad token/);
    const down = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
    await expect(registryRpc(down)("agent_of", {})).rejects.toThrow(/HTTP 502/);
  });
});

describe("holding a named agent wallet to account", () => {
  it("refuses, before any charge, a payment signed by a different wallet than the one named", () => {
    expect(claimMismatch(null, "anything")).toBeNull();
    expect(claimMismatch(WALLET, WALLET)).toBeNull();
    expect(claimMismatch(WALLET, "OtherWallet")).toMatch(/signed by OtherWallet, not the agent named/);
    expect(claimMismatch(WALLET, null)).toMatch(/could not be read/);
  });
});

describe("AfriRadar's own agents", () => {
  const canonical = JSON.parse(readFileSync("test/fixtures/cis8-canonical.json", "utf8")) as Record<string, string>;
  const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

  it("holds a valid solana-ed25519 signature from each wallet over its CIS-8 canonical bytes", async () => {
    for (const a of Object.values(AFRIRADAR_AGENTS)) {
      const key = await crypto.subtle.importKey("raw", fromHex(solanaKeyHex(a.wallet)), { name: "Ed25519" }, false, ["verify"]);
      expect(await crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(a.cis8Signature!), fromHex(canonical[a.id]))).toBe(true);
      // The bytes name the owner's account, the CIS-8 registry and the wallet's network and key.
      const text = Buffer.from(fromHex(canonical[a.id])).toString("latin1");
      expect(text.startsWith("CIS-8/v1/canonical")).toBe(true);
      expect(text).toContain(a.solanaNetwork);
      expect(canonical[a.id]).toContain(solanaKeyHex(a.wallet));
    }
    // A signature from the wrong wallet does not pass.
    const key = await crypto.subtle.importKey("raw", fromHex(solanaKeyHex(AFRIRADAR_AGENTS.buyer.wallet)), { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(AFRIRADAR_AGENTS.seller.cis8Signature!), fromHex(canonical.buyer))).toBe(false);
  });

  it("writes each card the same way every time, naming the testnet registry and the bound wallet", async () => {
    const seller = agentCard(AFRIRADAR_AGENTS.seller);
    expect(agentCard(AFRIRADAR_AGENTS.seller)).toBe(seller);
    const card = JSON.parse(seller);
    expect(card.x402Support).toBe(true);
    expect(card.url).toBe(AFRIRADAR_AGENTS.seller.agentUri);
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(Object.keys(PRODUCTS));
    const ext = card.capabilities.extensions[0];
    expect(ext.uri).toBe("https://docs.concordium.com/a2a-extensions/concordium-badge/v1");
    expect(ext.params.contracts).toEqual({ cis8004: "ccd:4221332d34e1694168c2a0c0b3fd0f27:12802.0", cis8: "ccd:4221332d34e1694168c2a0c0b3fd0f27:12801.0" });
    expect(ext.params.externalKey).toMatchObject({ namespace: MAINNET, keyType: "ed25519", address: AFRIRADAR_AGENTS.seller.wallet });
    expect(await sha256Hex(seller)).toMatch(/^[0-9a-f]{64}$/);
  });
});
