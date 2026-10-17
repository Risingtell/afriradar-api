// MCP server: gives any MCP-capable AI agent tools that buy AfriRadar data with its own wallet.
// Each paid tool result ends with the Solana transaction, so the agent (and its user) see what was spent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createAfriRadar, type Category, type Paid } from "./client.js";
import { loadSigner } from "./wallet.js";

const CATEGORIES = ["money-market", "bond", "dollar", "equity", "balanced", "shariah", "reit", "ethical", "specialised"] as const;

export async function runMcp(opts: { baseUrl?: string; rpcUrl?: string } = {}) {
  const budget = process.env.AFRIRADAR_BUDGET ? Number(process.env.AFRIRADAR_BUDGET) : 0.5;
  const api = createAfriRadar({ signer: await loadSigner(), baseUrl: opts.baseUrl, rpcUrl: opts.rpcUrl, budget });
  const server = new McpServer({ name: "afriradar", version: "0.1.0" });
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  const paid = async <T>(p: Promise<Paid<T>>) => {
    const r = await p;
    return text({ ...r, spentThisSession: api.spent, budget });
  };

  server.tool("afriradar_search", "Free. Find Nigerian fund ids and Kenyan unit trust scheme ids by name.", { query: z.string() }, async ({ query }) => text(await api.search(query)));
  server.tool("afriradar_kenya", "Paid $0.002 USDC. Kenya: every unit trust scheme for the latest CMA quarter, assets in KES (quarterly, per scheme, no yields).", {}, async () => paid(api.kenya()));
  server.tool("afriradar_kenya_scheme", "Paid $0.001 USDC. Kenya: one unit trust scheme's quarterly assets since December 2023. id like sanlam", { id: z.string().regex(/^[a-z0-9-]+$/) }, async ({ id }) => paid(api.kenyaScheme(id)));
  server.tool("afriradar_overview", "Free. Latest SEC week and a summary of every fund category.", {}, async () => text(await api.overview()));
  server.tool(
    "afriradar_top",
    "Paid $0.002 USDC. Rank a category's funds for the latest SEC week.",
    { category: z.enum(CATEGORIES), by: z.enum(["yield_ytd", "yield_wtd", "nav", "unitholders"]).default("yield_ytd"), limit: z.number().int().min(1).max(50).default(10) },
    async ({ category, by, limit }) => paid(api.top(category as Category, { by, limit })),
  );
  server.tool("afriradar_category", "Paid $0.002 USDC. Every fund in one category, latest week.", { category: z.enum(CATEGORIES) }, async ({ category }) => paid(api.category(category as Category)));
  server.tool("afriradar_fund", "Paid $0.001 USDC. One fund's latest figures and last 13 weeks. id like money-market/aiico-money-market-fund", { id: z.string() }, async ({ id }) => paid(api.fund(id)));
  server.tool("afriradar_history", "Paid $0.005 USDC. One fund's full weekly history since January 2025.", { id: z.string() }, async ({ id }) => paid(api.history(id)));
  server.tool("afriradar_compare", "Paid $0.003 USDC. Up to 5 funds side by side.", { ids: z.array(z.string()).min(1).max(5) }, async ({ ids }) => paid(api.compare(ids)));
  server.tool("afriradar_ask", "Metered, at most $0.05 USDC. AfriRadar's own analyst answers a question from the data; you pay only for what it reads.", { question: z.string().min(3).max(500) }, async ({ question }) => paid(api.ask(question)));

  await server.connect(new StdioServerTransport());
}
