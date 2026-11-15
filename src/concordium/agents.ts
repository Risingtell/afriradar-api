// AfriRadar's own two agents in the Concordium Agent Registry, and the Agent Cards the registry anchors.
//
// - seller: AfriRadar itself. Its Solana wallet is the treasury every payment goes to, bound on Solana
//   mainnet, so a buyer can check, before paying, that the payTo address belongs to a registered agent.
// - buyer: the demo buyer that pays the API every hour (the monitor) on Solana devnet, so the public ledger
//   shows a verified agent's payments around the clock.
//
// The cards are served byte for byte from the API (/.well-known/agent-card.json, /agents/buyer.json): the
// registry stores their SHA-256, and anyone can fetch, hash and compare. A card names its own badge only
// after the agent NFT exists, so registration takes two steps: register with the first card, then publish
// the card with its tokenId and pin the new hash (setAgentURI). tokenId stays null until then.
import { MAINNET, NETWORK, PRODUCTS, usd } from "../catalog.js";
import { CONCORDIUM, type ConcordiumNet } from "./registry.js";

/** The Concordium testnet account that owns both agents and signs their registry transactions. */
export const OWNER = "4mX6mBtX2FUgoW8hMio2hcjZsh57hcPG2gN9vTi71bYrb5FoTj";
export const CONCORDIUM_NET: ConcordiumNet = "testnet";
/** CAIP-2 ids of the Concordium networks, as cards name them. */
const CCD_CHAIN = { testnet: "ccd:4221332d34e1694168c2a0c0b3fd0f27", mainnet: "ccd:9dd9ca4d19e9393877d2c44b70f89acb" } as const;

export type AfriradarAgent = {
  id: "seller" | "buyer";
  name: string;
  description: string;
  agentUri: string;
  /** The Solana wallet bound to OWNER through CIS-8, and the Solana network (CAIP-2) of the binding. */
  wallet: string;
  solanaNetwork: string;
  /** solana-ed25519 signature over the CIS-8 canonical bytes, from scripts/concordium-sign.ts. Public. */
  cis8Signature: string | null;
  /** The agent NFT's token id once registered; null before. */
  tokenId: string | null;
  /** Its badge (token address) once registered. */
  badge: string | null;
};

export const AFRIRADAR_AGENTS: Record<AfriradarAgent["id"], AfriradarAgent> = {
  seller: {
    id: "seller",
    name: "AfriRadar Data API",
    description: "Official Nigerian and Kenyan mutual fund data from SEC Nigeria and CMA Kenya, sold per request to people and AI agents over x402, paid in USDC on Solana. No account or subscription.",
    agentUri: "https://api.afriradar.com/.well-known/agent-card.json",
    wallet: "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8",
    solanaNetwork: MAINNET,
    cis8Signature: "b90c7711ce4f5f4e3f61f8b94ea04e211cc704df7ad06b43ac386a4dc383a2b8379d27b0c4d88f0fadf8cd74a44abe35df66b47430571048cf11231ff7beaa08",
    tokenId: null,
    badge: null,
  },
  buyer: {
    id: "buyer",
    name: "AfriRadar demo buyer",
    description: "The AfriRadar monitor's buying agent: every hour it pays the AfriRadar Data API for one fund over x402 on Solana devnet, and every six hours asks its analyst a question, so the payment path is checked end to end around the clock.",
    agentUri: "https://api.afriradar.com/agents/buyer.json",
    wallet: "2VJtvNGAYZiFAejH4nVWDmw2pjoFtgEQsVFsAV2LpXTK",
    solanaNetwork: NETWORK,
    cis8Signature: "7acb841c49a3ce45532263bdc3d0471f7655889252fb0691a6e54cec2ad6e422fb9969901eb1ed599d95c94c7a066b7c0ee4ab130909fd0f481487a39099e405",
    tokenId: null,
    badge: null,
  },
};

/** The agent's card, as the exact bytes served and hashed. Same layout as the registry's build_agent_card. */
export function agentCard(agent: AfriradarAgent, net: ConcordiumNet = CONCORDIUM_NET): string {
  const c = CONCORDIUM[net];
  const chain = CCD_CHAIN[net];
  const skills = agent.id === "seller"
    ? Object.entries(PRODUCTS).map(([id, p]) => ({
      id,
      name: `${p.method} ${p.path}`,
      description: `${p.summary} Price ${usd(p.price)}${p.scheme === "upto" ? " at most, metered" : ""}, paid over x402.`,
      tags: ["x402", "solana", "usdc", p.scheme],
      examples: [p.example],
    }))
    : [{ id: "buy-fund-data", name: "Buy AfriRadar fund data", description: "Pays for /v1/funds and /v1/ask over x402 on Solana devnet, on a schedule.", tags: ["x402", "solana", "buyer"], examples: ["GET https://api.afriradar.com/v1/funds/money-market/stanbic-ibtc-money-market-fund"] }];
  const card = {
    name: agent.name,
    description: agent.description,
    url: agent.agentUri,
    version: "1.0.0",
    provider: { organization: "Rising Technology", url: "https://www.afriradar.com" },
    documentationUrl: "https://api.afriradar.com/",
    x402Support: true,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    authentication: { schemes: [] },
    skills,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1",
          description: "Verified by Concordium badge — on-chain agent identity in a CIS-8004 registry",
          required: false,
          params: {
            tokenAddress: agent.badge,
            tokenId: agent.tokenId,
            owner: { account: `${chain}:${OWNER}` },
            agentWallet: `${chain}:${OWNER}`,
            externalKey: { namespace: agent.solanaNetwork, keyType: "ed25519", address: agent.wallet, registry: `${chain}:${c.cis8.index}.${c.cis8.subindex}` },
            contracts: { cis8004: `${chain}:${c.cis8004.index}.${c.cis8004.subindex}`, cis8: `${chain}:${c.cis8.index}.${c.cis8.subindex}` },
            verify: "Resolve tokenAddress via CIS-8004 agent_of; confirm owner + status=Active + card SHA-256 == metadata_hash.",
            verification: {
              service: "Concordium Agent Registry",
              verifyUrl: `https://agent-registry-mcp.concordium.com/v1/badge-check/${agent.badge ?? OWNER}`,
              mcp: "https://agent-registry-mcp.concordium.com/mcp",
              afriradar: `https://api.afriradar.com/v1/agents/${agent.wallet}?network=${agent.solanaNetwork === MAINNET ? "mainnet" : "devnet"}`,
              docs: "https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/concordium-badge.html",
            },
          },
        },
      ],
    },
  };
  return JSON.stringify(card, null, 2) + "\n";
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
