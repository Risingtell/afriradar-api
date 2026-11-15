// Concordium Agent Registry checks for paying Solana wallets: verified only when the key binding, an Active
// agent and a matching card all hold; failures never verify and are never cached.
import { describe, expect, it } from "vitest";
import { agentCheck, CHECK_TTL_MS, CONCORDIUM, lookUpAgent, registryRpc, solanaKeyHex } from "../src/concordium/registry.js";
import { NETWORK } from "../src/catalog.js";
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
