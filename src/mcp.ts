// A hosted MCP server at /mcp, so an AI agent can use AfriRadar as tools without installing
// anything. Stateless Streamable HTTP with JSON replies. Free tools answer directly. Paid tools are
// x402 payments carried inside MCP (@x402/mcp): the first call returns the price, the agent's x402
// MCP client pays in _meta and calls again, and the settlement lands in the same public ledger.
// The analyst is metered (x402 upto) and stays on HTTP: POST /v1/ask.
import type { Hono } from "hono";
import type { x402ResourceServer } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createPaymentWrapper } from "@x402/mcp";
import { NETWORK, PRODUCTS, usd } from "./catalog.js";
import type { Db } from "./db.js";
import { CATEGORIES, isCategory } from "./data/model.js";
import * as kenya from "./data/kenya.js";
import * as q from "./data/queries.js";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_SERVER = { name: "afriradar", version: "1.0.0" };

class ToolInputError extends Error {}
type Args = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };
export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; price?: number; run: (args: Args) => Promise<unknown> };

const str = (args: Args, key: string) => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolInputError(`${key} is required`);
  return v.trim();
};
const found = <T>(what: string, v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new ToolInputError(`${what} not found`);
  return v;
};
const category = (args: Args) => {
  const c = str(args, "category");
  if (!isCategory(c)) throw new ToolInputError(`category must be one of ${Object.keys(CATEGORIES).join(", ")}`);
  return c;
};
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const CATEGORY = { type: "string", enum: Object.keys(CATEGORIES), description: "Fund category" };
const FUND_ID = { type: "string", description: 'Fund id from afriradar_search, e.g. "money-market/aiico-money-market-fund"' };

export function mcpTools(db: Db, extra: { status: () => Promise<unknown>; networks?: string[] }): McpTool[] {
  return [
    {
      name: "afriradar_catalog",
      description: "Free. What AfriRadar sells, the price of each product in USDC, and how to pay (x402 on Solana: devnet test USDC, or real USDC on mainnet).",
      inputSchema: schema(),
      run: async () => ({
        networks: extra.networks ?? [NETWORK],
        products: Object.entries(PRODUCTS).map(([id, p]) => ({ id, http: `${p.method} https://api.afriradar.com${p.path}`, price: usd(p.price), scheme: p.scheme, summary: p.summary })),
        mcp: "Paid tools here charge the same prices over x402 inside MCP. The analyst is HTTP only: POST https://api.afriradar.com/v1/ask.",
      }),
    },
    {
      name: "afriradar_search",
      description: "Free. Find fund ids by name or manager, across SEC Nigeria funds and CMA Kenya unit trust schemes.",
      inputSchema: schema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 25 } }, ["query"]),
      run: async (a) => {
        const text = str(a, "query");
        const limit = Number(a.limit) || 10;
        return { results: await q.search(db, text, limit), kenya: await kenya.searchKenya(db, text, limit) };
      },
    },
    {
      name: "afriradar_overview",
      description: "Free. Market totals: Nigerian funds by category for the latest SEC week, and Kenya's latest CMA quarter.",
      inputSchema: schema(),
      run: async () => ({ ...(await q.overview(db)), kenya: await kenya.kenyaOverview(db) }),
    },
    {
      name: "afriradar_status",
      description: "Free. Payment reliability: results of the hourly end-to-end payment check, and the public ledger totals.",
      inputSchema: schema(),
      run: extra.status,
    },
    {
      name: "afriradar_fund",
      description: `${usd(PRODUCTS.fund.price)}. ${PRODUCTS.fund.summary}`,
      inputSchema: schema({ id: FUND_ID }, ["id"]),
      price: PRODUCTS.fund.price,
      run: async (a) => found("fund", await q.fund(db, str(a, "id"))),
    },
    {
      name: "afriradar_history",
      description: `${usd(PRODUCTS.history.price)}. ${PRODUCTS.history.summary}`,
      inputSchema: schema({ id: FUND_ID }, ["id"]),
      price: PRODUCTS.history.price,
      run: async (a) => found("fund", await q.history(db, str(a, "id"))),
    },
    {
      name: "afriradar_category",
      description: `${usd(PRODUCTS.category.price)}. ${PRODUCTS.category.summary}`,
      inputSchema: schema({ category: CATEGORY }, ["category"]),
      price: PRODUCTS.category.price,
      run: async (a) => q.category(db, category(a)),
    },
    {
      name: "afriradar_top",
      description: `${usd(PRODUCTS.top.price)}. ${PRODUCTS.top.summary}`,
      inputSchema: schema({ category: CATEGORY, by: { type: "string", enum: Object.keys(q.RANK_BY) }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["category"]),
      price: PRODUCTS.top.price,
      run: async (a) => {
        const by = String(a.by ?? "yield_ytd");
        if (!(by in q.RANK_BY)) throw new ToolInputError(`by must be one of ${Object.keys(q.RANK_BY).join(", ")}`);
        return q.top(db, category(a), by as q.RankBy, Number(a.limit) || 10);
      },
    },
    {
      name: "afriradar_compare",
      description: `${usd(PRODUCTS.compare.price)}. ${PRODUCTS.compare.summary}`,
      inputSchema: schema({ ids: { type: "array", items: FUND_ID, minItems: 1, maxItems: 5 } }, ["ids"]),
      price: PRODUCTS.compare.price,
      run: async (a) => {
        const ids = Array.isArray(a.ids) ? a.ids.map(String).filter(Boolean) : [];
        if (!ids.length || ids.length > 5) throw new ToolInputError("ids must list 1 to 5 fund ids");
        return q.compare(db, ids);
      },
    },
    {
      name: "afriradar_kenya",
      description: `${usd(PRODUCTS.kenya.price)}. ${PRODUCTS.kenya.summary}`,
      inputSchema: schema(),
      price: PRODUCTS.kenya.price,
      run: async () => {
        const data = await kenya.kenyaSchemes(db);
        if (!data.quarter) throw new ToolInputError("Kenya data not found");
        return data;
      },
    },
    {
      name: "afriradar_kenya_scheme",
      description: `${usd(PRODUCTS.kenyaScheme.price)}. ${PRODUCTS.kenyaScheme.summary}`,
      inputSchema: schema({ scheme: { type: "string", description: 'Scheme key from afriradar_search, e.g. "sanlam"' } }, ["scheme"]),
      price: PRODUCTS.kenyaScheme.price,
      run: async (a) => found("scheme", await kenya.kenyaScheme(db, str(a, "scheme"))),
    },
  ];
}

const asResult = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data },
});
const errorResult = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** `networks`: where paid tools accept payment, devnet first. */
export function mountMcp(app: Hono, opts: { db: Db; resourceServer: x402ResourceServer; treasury: string; networks: Network[]; status: () => Promise<unknown> }) {
  const tools = mcpTools(opts.db, { status: opts.status, networks: opts.networks });
  const byName = new Map(tools.map((t) => [t.name, t]));

  const plain = (t: McpTool) => async (args: Args): Promise<ToolResult> => {
    try {
      return asResult(await t.run(args));
    } catch (e) {
      if (e instanceof ToolInputError) return errorResult(`${e.message}; you were not charged`);
      throw e;
    }
  };
  // Paid handlers are built once, on first use, after the resource server has its facilitator's kinds.
  let paidHandlers: Promise<Map<string, (args: Args, extra: { _meta?: Record<string, unknown> }) => Promise<ToolResult>>> | undefined;
  const paid = () =>
    (paidHandlers ??= (async () => {
      const out = new Map<string, (args: Args, extra: { _meta?: Record<string, unknown> }) => Promise<ToolResult>>();
      for (const t of tools.filter((x) => x.price)) {
        const accepts = (await Promise.all(opts.networks.map((network) => opts.resourceServer.buildPaymentRequirements({ scheme: "exact", network, payTo: opts.treasury, price: usd(t.price as number) })))).flat();
        const wrap = createPaymentWrapper(opts.resourceServer, {
          accepts,
          resource: { url: `mcp://tool/${t.name}`, description: t.description, mimeType: "application/json" },
          extensions: declareDiscoveryExtension({ toolName: t.name, description: t.description, transport: "streamable-http", inputSchema: t.inputSchema }),
        });
        out.set(t.name, wrap(plain(t)) as unknown as (args: Args, extra: { _meta?: Record<string, unknown> }) => Promise<ToolResult>);
      }
      return out;
    })().catch((e) => {
      paidHandlers = undefined;
      throw e;
    }));

  type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
  const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function handle(m: Rpc) {
    const params = m.params ?? {};
    switch (m.method) {
      case "initialize": {
        const asked = String(params.protocolVersion ?? "");
        return reply(m.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER,
          instructions: "African fund data from the regulators (SEC Nigeria weekly, CMA Kenya quarterly). Tools marked Free answer directly; priced tools are paid per call in USDC on Solana over x402 (devnet test USDC, or real USDC on mainnet), using an x402 MCP client. Start with afriradar_search to find ids.",
        });
      }
      case "ping":
        return reply(m.id, {});
      case "tools/list":
        return reply(m.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const name = String(params.name ?? "");
        const tool = byName.get(name);
        if (!tool) return fail(m.id, -32602, `unknown tool ${name}`);
        const args = (params.arguments ?? {}) as Args;
        const result = tool.price ? await (await paid()).get(name)!(args, { _meta: params._meta as Record<string, unknown> | undefined }) : await plain(tool)(args);
        return reply(m.id, result);
      }
      default:
        return fail(m.id, -32601, `method ${m.method} is not supported`);
    }
  }

  app.post("/mcp", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Rpc | Rpc[] | undefined;
    if (!body || typeof body !== "object") return c.json(fail(null, -32700, "parse error: send a JSON-RPC message"), 400);
    const messages = Array.isArray(body) ? body : [body];
    // Notifications and client responses carry no id and get no reply.
    const replies = (await Promise.all(messages.filter((m) => m.method && m.id !== undefined && m.id !== null).map(handle))).filter(Boolean);
    if (!replies.length) return c.body(null, 202);
    return c.json(Array.isArray(body) ? replies : replies[0]);
  });
  // No server-to-client stream: every reply comes back on the POST.
  app.get("/mcp", (c) => c.json({ error: "this MCP server is stateless; POST JSON-RPC to /mcp" }, 405));
}
