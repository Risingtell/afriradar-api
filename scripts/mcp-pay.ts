// Pays a paid AfriRadar MCP tool over x402 inside MCP, with the official @x402/mcp client and the MCP
// SDK's Streamable HTTP transport. Lists the tools, calls a free one, then pays for a Kenya scheme.
//   set -a; . ./.env; set +a; npx tsx scripts/mcp-pay.ts [https://api.afriradar.com/mcp]
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createx402MCPClient } from "@x402/mcp";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const url = process.argv[2] ?? "https://api.afriradar.com/mcp";
const buyer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync("keys/buyer.json", "utf8"))));
const client = createx402MCPClient({
  name: "afriradar-check", version: "1.0.0",
  schemes: [{ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", client: new ExactSvmScheme(buyer, { rpcUrl: process.env.SVM_RPC_URL }) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) => { console.log("price asked:", paymentRequired.accepts[0].amount, "micro-USDC"); return true; },
});
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const free = await client.callTool("afriradar_search", { query: "sanlam" });
console.log("free search:", JSON.stringify(free.content).slice(0, 140));
const paid = await client.callTool("afriradar_kenya_scheme", { scheme: "sanlam" });
console.log("paid result:", JSON.stringify(paid.content).slice(0, 160));
console.log("payment made:", paid.paymentMade, "tx:", paid.paymentResponse?.transaction);
await client.close();
process.exit(0);
