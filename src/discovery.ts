// x402 Bazaar discovery: every paid HTTP route declares how to call it (inputs, path parameters,
// body), so its 402 carries machine-readable instructions an agent can follow. /discovery/resources
// lists the HTTP products and the paid MCP tools in the Bazaar listing format.
import type { Hono } from "hono";
import type { x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { PRODUCTS, usd, type ProductId } from "./catalog.js";
import { CATEGORIES } from "./data/model.js";
import type { McpTool } from "./mcp.js";

const BASE = "https://api.afriradar.com";
const CATEGORY = { type: "string", enum: Object.keys(CATEGORIES) };
const pathSchema = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props) });

/** How to call each paid HTTP product, for the route's x402 Bazaar extension. */
export const DISCOVERY: Record<ProductId, Parameters<typeof declareDiscoveryExtension>[0]> = {
  category: { pathParams: { category: "money-market" }, pathParamsSchema: pathSchema({ category: CATEGORY }) },
  fund: { pathParams: { category: "money-market", slug: "aiico-money-market-fund" }, pathParamsSchema: pathSchema({ category: CATEGORY, slug: { type: "string" } }) },
  history: { pathParams: { category: "money-market", slug: "aiico-money-market-fund" }, pathParamsSchema: pathSchema({ category: CATEGORY, slug: { type: "string" } }) },
  top: {
    pathParams: { category: "money-market" },
    pathParamsSchema: pathSchema({ category: CATEGORY }),
    input: { by: "yield_ytd", limit: "5" },
    inputSchema: { type: "object", properties: { by: { type: "string", enum: ["yield_ytd", "yield_wtd", "nav", "unitholders"] }, limit: { type: "string" } } },
  },
  compare: {
    input: { ids: "money-market/aiico-money-market-fund,money-market/first-ally-money-market-fund" },
    inputSchema: { type: "object", properties: { ids: { type: "string", description: "1 to 5 comma-separated fund ids" } }, required: ["ids"] },
  },
  kenya: {},
  kenyaScheme: { pathParams: { scheme: "sanlam" }, pathParamsSchema: pathSchema({ scheme: { type: "string" } }) },
  ask: {
    bodyType: "json",
    input: { question: "Which naira money market fund pays the most this year?" },
    inputSchema: { type: "object", properties: { question: { type: "string", minLength: 3, maxLength: 500 } }, required: ["question"] },
  },
};

export const discoveryExtension = (id: ProductId) => declareDiscoveryExtension(DISCOVERY[id]);

// Fields that only make sense in a live challenge; a listing would serve them stale.
const LIVE_ONLY = ["recentBlockhash", "lastValidBlockHeight", "recentSlot"];
const forListing = (r: PaymentRequirements) => ({ ...r, extra: Object.fromEntries(Object.entries(r.extra ?? {}).filter(([k]) => !LIVE_ONLY.includes(k))) });

export function mountDiscovery(app: Hono, opts: { resourceServer: x402ResourceServer; treasury: string; networks: Network[]; tools: McpTool[]; now: () => Date }) {
  let cached: { at: number; body: unknown } | undefined;
  app.get("/discovery/resources", async (c) => {
    if (cached && Date.now() - cached.at < 10 * 60_000) return c.json(cached.body);
    const lastUpdated = opts.now().toISOString();
    const accepts = async (scheme: "exact" | "upto", price: number) =>
      (await Promise.all(opts.networks.map((network) => opts.resourceServer.buildPaymentRequirements({ scheme, network, payTo: opts.treasury, price: usd(price) })))).flat().map(forListing);
    const http = await Promise.all(
      (Object.keys(PRODUCTS) as ProductId[]).map(async (id) => {
        const p = PRODUCTS[id];
        return {
          resource: `${BASE}${p.path}`,
          type: "http",
          x402Version: 2,
          accepts: await accepts(p.scheme, p.price),
          lastUpdated,
          description: p.summary,
          mimeType: "application/json",
          serviceName: "AfriRadar Data API",
          tags: ["finance", "africa", "funds", id.startsWith("kenya") ? "kenya" : id === "ask" ? "ai" : "nigeria"],
          extensions: discoveryExtension(id),
        };
      }),
    );
    const mcp = await Promise.all(
      opts.tools.filter((t) => t.price).map(async (t) => ({
        resource: `mcp://tool/${t.name}`,
        type: "mcp",
        x402Version: 2,
        accepts: await accepts("exact", t.price as number),
        lastUpdated,
        description: `${t.description} MCP endpoint: ${BASE}/mcp`,
        mimeType: "application/json",
        serviceName: "AfriRadar Data API",
        tags: ["finance", "africa", "funds", "mcp"],
        extensions: declareDiscoveryExtension({ toolName: t.name, description: t.description, transport: "streamable-http", inputSchema: t.inputSchema }),
      })),
    );
    const items = [...http, ...mcp];
    const body = { x402Version: 2, items, pagination: { limit: items.length, offset: 0, total: items.length } };
    cached = { at: Date.now(), body };
    return c.json(body);
  });
}
