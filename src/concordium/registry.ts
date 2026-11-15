// Which AI agent is paying? Buyers pay AfriRadar in USDC on Solana (x402). Concordium's Agent Registry says
// who stands behind a Solana wallet: its owner binds the wallet's ed25519 key to their Concordium account
// (CIS-8, the signature is checked on chain), then registers an agent (a CIS-8004 NFT, the "Verified by
// Concordium" badge) whose external reference is that key, with an Agent Card whose SHA-256 is anchored on
// chain. A paying wallet counts as a verified agent only when all of it holds today: the binding, an agent
// that is Active, and a card whose bytes still match the on-chain hash.
//
// Reads go through Concordium's public Agent Registry MCP service, which reads the chain and holds no keys.
// Results are kept for an hour in agent_checks, so a busy buyer costs one lookup an hour, not one per call.
import { getAddressEncoder, type Address } from "@solana/kit";
import type { Db } from "../db.js";

export const REGISTRY_MCP = "https://agent-registry-mcp.concordium.com/mcp";

/** Concordium testnet, where the hackathon build runs; mainnet is a setting, not a code change. */
export const CONCORDIUM = {
  testnet: { network: "testnet", cis8004: { index: 12802, subindex: 0 }, cis8: { index: 12801, subindex: 0 }, explorer: "https://testnet.ccdscan.io" },
  mainnet: { network: "mainnet", cis8004: { index: 10082, subindex: 0 }, cis8: { index: 10081, subindex: 0 }, explorer: "https://ccdscan.io" },
} as const;
export type ConcordiumNet = keyof typeof CONCORDIUM;

export const CHECK_TTL_MS = 60 * 60 * 1000;

export type AgentCheck = {
  /** The Solana wallet (base58) and the Solana network (CAIP-2) its key was bound for. */
  wallet: string;
  solanaNetwork: string;
  verified: boolean;
  /** Why it is or is not verified, in plain words. */
  reason: string;
  agent: null | {
    tokenId: string;
    /** The badge: the agent NFT's token address. */
    badge: string;
    owner: string;
    agentUri: string | null;
    status: string;
    cardMatches: boolean | null;
  };
  concordium: ConcordiumNet;
  checkedAt: string;
};

type Rpc = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** One tools/call to the registry service; the tool's JSON answer, or null when it answered null. */
export function registryRpc(fetchImpl: typeof fetch = fetch, url = REGISTRY_MCP): Rpc {
  let id = 0;
  return async (tool, args) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`registry ${tool}: HTTP ${res.status}`);
    const body = (await res.json()) as { error?: { message?: string }; result?: { isError?: boolean; content?: { text?: string }[] } };
    if (body.error) throw new Error(`registry ${tool}: ${body.error.message ?? "error"}`);
    const text = body.result?.content?.[0]?.text ?? "null";
    if (body.result?.isError) throw new Error(`registry ${tool}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
}

/** A Solana address is its ed25519 public key in base58; the registry wants the 32 bytes in hex. */
export function solanaKeyHex(wallet: string): string {
  const bytes = getAddressEncoder().encode(wallet as Address);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type AgentRecord = {
  token_id?: string | number;
  token_address?: string;
  owner_account?: string;
  owner?: string;
  agent_uri?: string | null;
  status?: string;
};

/** Looks the wallet up on chain now, without the cache. Never throws: a failed lookup is "not verified". */
export async function lookUpAgent(wallet: string, solanaNetwork: string, opts: { rpc: Rpc; concordium?: ConcordiumNet; now?: Date }): Promise<AgentCheck> {
  const net = CONCORDIUM[opts.concordium ?? "testnet"];
  const base = { wallet, solanaNetwork, concordium: net.network as ConcordiumNet, checkedAt: (opts.now ?? new Date()).toISOString() };
  let keyHex: string;
  try {
    keyHex = solanaKeyHex(wallet);
  } catch {
    return { ...base, verified: false, reason: "not a Solana address", agent: null };
  }
  try {
    const found = (await opts.rpc("agent_by_external_reference", {
      network: net.network,
      external_reference: { kind: "Cis8", contract_address: net.cis8, key: { namespace: solanaNetwork, key_type: "ed25519", public_key_hex: keyHex } },
    })) as { agent?: AgentRecord } & AgentRecord | null;
    const rec: AgentRecord | null = found ? (found.agent ?? found) : null;
    if (!rec || rec.token_id === undefined) {
      return { ...base, verified: false, reason: "no Concordium agent is registered for this wallet", agent: null };
    }
    const tokenId = String(rec.token_id);
    const status = String(rec.status ?? "unknown");
    const card = status === "Active"
      ? ((await opts.rpc("verify_agent_card", { network: net.network, token_id: tokenId })) as { match?: boolean | null } | null)
      : null;
    const cardMatches = card ? (card.match ?? null) : null;
    const agent = {
      tokenId,
      badge: String(rec.token_address ?? ""),
      owner: String(rec.owner_account ?? rec.owner ?? ""),
      agentUri: rec.agent_uri ?? null,
      status,
      cardMatches,
    };
    if (status !== "Active") return { ...base, verified: false, reason: `the agent is ${status}, not Active`, agent };
    if (cardMatches !== true) return { ...base, verified: false, reason: "the agent's card does not match its on-chain hash", agent };
    return { ...base, verified: true, reason: "registered, Active, and its card matches the on-chain hash", agent };
  } catch (e) {
    return { ...base, verified: false, reason: `the registry could not be read: ${String((e as Error).message ?? e).slice(0, 120)}`, agent: null };
  }
}

/**
 * The check for a wallet, from the hour-long cache when fresh. A failed lookup is never kept, and with
 * store: false nothing is written at all (the free endpoint, for wallets that have never paid, so random
 * lookups cannot spend the database's daily write allowance).
 */
export async function agentCheck(db: Db, wallet: string, solanaNetwork: string, opts: { rpc: Rpc; concordium?: ConcordiumNet; now?: Date; store?: boolean }): Promise<AgentCheck> {
  const now = opts.now ?? new Date();
  const row = await db.first<{ body: string; checked_at: string }>(
    "SELECT body, checked_at FROM agent_checks WHERE wallet = ? AND solana_network = ?", wallet, solanaNetwork,
  );
  if (row && now.getTime() - Date.parse(row.checked_at) < CHECK_TTL_MS) return JSON.parse(row.body) as AgentCheck;
  const check = await lookUpAgent(wallet, solanaNetwork, { ...opts, now });
  if (opts.store !== false && !check.reason.startsWith("the registry could not be read")) {
    await db.run(
      `INSERT INTO agent_checks (wallet, solana_network, verified, badge, body, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (wallet, solana_network) DO UPDATE SET verified = excluded.verified, badge = excluded.badge, body = excluded.body, checked_at = excluded.checked_at`,
      wallet, solanaNetwork, check.verified ? 1 : 0, check.agent?.badge ?? null, JSON.stringify(check), check.checkedAt,
    );
  }
  return check;
}
