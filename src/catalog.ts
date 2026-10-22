// The one list of what AfriRadar sells, at what price. The x402 route config, the free /v1 catalog,
// the docs and the agent's tool prices are all generated from this, so they cannot disagree.

export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const; // Solana devnet, the default
export const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const; // Solana mainnet, real USDC
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** Both networks, devnet first: a buyer that accepts any Solana network pays with free test USDC. */
export const CHAINS = {
  devnet: { id: "devnet", network: NETWORK, usdc: USDC_DEVNET, label: "Solana devnet", money: "free test USDC" },
  mainnet: { id: "mainnet", network: MAINNET, usdc: USDC_MAINNET, label: "Solana mainnet", money: "real USDC" },
} as const;
export type ChainId = keyof typeof CHAINS;
export const chainOf = (network: string | null | undefined) => (network === MAINNET ? CHAINS.mainnet : CHAINS.devnet);
export const explorerUrl = (sig: string, network?: string | null) => `https://explorer.solana.com/tx/${sig}${network === MAINNET ? "" : "?cluster=devnet"}`;

/** USDC amounts are handled as integer micro-USDC (6 decimals) everywhere. */
export const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

export type Product = {
  method: "GET" | "POST";
  path: string; // Hono pattern
  scheme: "exact" | "upto";
  price: number; // micro-USDC; for upto this is the ceiling the buyer authorizes
  summary: string;
  example: string;
};

export const PRODUCTS = {
  category: {
    method: "GET", path: "/v1/categories/:category", scheme: "exact", price: 2_000,
    summary: "Every fund in one category for the latest SEC week: NAV, yields, unitholders, prices.",
    example: "/v1/categories/money-market",
  },
  fund: {
    method: "GET", path: "/v1/funds/:category/:slug", scheme: "exact", price: 1_000,
    summary: "One fund: latest figures plus its last 13 weeks.",
    example: "/v1/funds/money-market/aiico-money-market-fund",
  },
  history: {
    method: "GET", path: "/v1/funds/:category/:slug/history", scheme: "exact", price: 5_000,
    summary: "One fund's full weekly history since January 2025, with the SEC source file for every week.",
    example: "/v1/funds/money-market/aiico-money-market-fund/history",
  },
  top: {
    method: "GET", path: "/v1/top/:category", scheme: "exact", price: 2_000,
    summary: "Funds ranked by yield_ytd, yield_wtd, nav or unitholders (?by=, ?limit= up to 50).",
    example: "/v1/top/money-market?by=yield_ytd&limit=5",
  },
  compare: {
    method: "GET", path: "/v1/compare", scheme: "exact", price: 3_000,
    summary: "Up to 5 funds side by side, with yield and NAV change over 4 and 13 weeks (?ids=a,b).",
    example: "/v1/compare?ids=money-market/aiico-money-market-fund,money-market/first-ally-money-market-fund",
  },
  kenya: {
    method: "GET", path: "/v1/kenya/unit-trusts", scheme: "exact", price: 2_000,
    summary: "Kenya: every unit trust scheme for the latest CMA quarter, with assets under management, change on the quarter and market share.",
    example: "/v1/kenya/unit-trusts",
  },
  kenyaScheme: {
    method: "GET", path: "/v1/kenya/unit-trusts/:scheme", scheme: "exact", price: 1_000,
    summary: "Kenya: one unit trust scheme's quarterly assets since December 2023, with the CMA bulletin for every quarter.",
    example: "/v1/kenya/unit-trusts/sanlam",
  },
  ask: {
    method: "POST", path: "/v1/ask", scheme: "upto", price: 50_000,
    summary: "Ask a question in plain English about Nigerian or Kenyan funds. An AI analyst buys the data it needs and answers with sources. You authorize up to $0.05 and pay only for the data read and the AI tokens used.",
    example: '/v1/ask  {"question":"Which naira money market fund pays the most this year?"}',
  },
} as const satisfies Record<string, Product>;

export type ProductId = keyof typeof PRODUCTS;

/** Metering for /v1/ask: a base fee, each dataset at its list price, and AI tokens. */
export const ASK_PRICING = {
  base: 1_000, // $0.001 per question
  perThousandTokens: 500, // $0.0005 per 1,000 AI tokens (prompt + completion)
} as const;
