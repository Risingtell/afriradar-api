// Live smoke test: starts `afriradar mcp` over stdio like an AI agent would, lists tools, calls one free and one paid.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "mcp"], env: { ...process.env } });
const client = new Client({ name: "smoke", version: "1" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const s = await client.callTool({ name: "afriradar_search", arguments: { query: "coronation money" } });
console.log("search:", s.content[0].text.slice(0, 160));
const p = await client.callTool({ name: "afriradar_fund", arguments: { id: "money-market/coronation-money-market-fund" } });
const body = JSON.parse(p.content[0].text);
console.log("paid fund:", body.data.name, body.data.yieldYtd, "| receipt", body.receipt.usdc, body.receipt.transaction.slice(0, 12), "| spent", body.spentThisSession, "of", body.budget);
await client.close();
