#!/usr/bin/env node
// afriradar: buy African fund data (SEC Nigeria, CMA Kenya) from the terminal, paid in USDC on Solana devnet.
import { createSolanaRpc, address } from "@solana/kit";
import { createAfriRadar, AfriRadarError, DEFAULT_BASE_URL, DEVNET_RPC, type Category, type RankBy } from "./client.js";
import { verify, USDC_DEVNET } from "./verify.js";
import { createWallet, DEFAULT_WALLET, loadSigner } from "./wallet.js";

const HELP = `afriradar: African fund data (SEC Nigeria weekly, CMA Kenya quarterly), paid per request in USDC on Solana (devnet)

Free
  afriradar catalog                     products, prices, payee, data week
  afriradar search <words>              find fund ids (Nigeria) and scheme ids (Kenya) by name
  afriradar overview                    categories, fund counts, median yields
  afriradar verify                      recount every payment from the chain and check the API's ledger

Paid (your wallet pays; each prints its Solana transaction)
  afriradar top <category> [--by yield_ytd|yield_wtd|nav|unitholders] [--limit N]   $0.002
  afriradar category <category>         every fund in a category             $0.002
  afriradar fund <id>                   one fund, last 13 weeks              $0.001
  afriradar history <id>                full weekly history                  $0.005
  afriradar compare <id> <id> ...       up to 5 funds side by side           $0.003
  afriradar kenya                       Kenya: every unit trust scheme, latest quarter   $0.002
  afriradar kenya <scheme>              Kenya: one scheme, every quarter     $0.001
  afriradar ask "<question>"            AI analyst, you pay for what it reads (max $0.05)

Wallet
  afriradar wallet [--new]              show (or create) ${DEFAULT_WALLET}
  afriradar mcp                         run as an MCP server (tools for AI agents)

Options  --json  --api <url>  --rpc <url>  --max <usdc per request>  --budget <usdc>
Env      AFRIRADAR_KEY (base58 or JSON secret) overrides the wallet file
Categories: money-market bond dollar equity balanced shariah reit ethical specialised`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const pct = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(2)}%` : "n/a");
const ngn = (v: unknown) => (typeof v === "number" ? `NGN ${(v / 1e9).toFixed(2)}bn` : "");

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  const json = flags.json === true;
  const baseUrl = typeof flags.api === "string" ? flags.api : process.env.AFRIRADAR_API ?? DEFAULT_BASE_URL;
  const rpcUrl = typeof flags.rpc === "string" ? flags.rpc : process.env.AFRIRADAR_RPC ?? DEVNET_RPC;
  const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : human);

  if (!cmd || cmd === "help" || flags.help) return console.log(HELP);

  if (cmd === "wallet") {
    const signer = flags.new ? await createWallet() : await loadSigner();
    const rpc = createSolanaRpc(rpcUrl);
    const sol = Number((await rpc.getBalance(signer.address).send()).value) / 1e9;
    const toks = await rpc.getTokenAccountsByOwner(signer.address, { mint: address(USDC_DEVNET) }, { encoding: "jsonParsed" }).send();
    const usdc = toks.value.reduce((a, t) => a + Number((t.account.data as { parsed: { info: { tokenAmount: { uiAmount: number } } } }).parsed.info.tokenAmount.uiAmount), 0);
    return out(
      `address ${signer.address}\nSOL     ${sol}\nUSDC    ${usdc}\n${usdc === 0 ? "Get free devnet USDC at https://faucet.circle.com (choose Solana Devnet). You need no SOL: the server pays network fees." : ""}`,
      { address: signer.address, sol, usdc },
    );
  }

  if (cmd === "verify") {
    const r = await verify({ baseUrl, rpcUrl });
    out(
      [
        `treasury        ${r.treasury} (USDC account ${r.tokenAccount})`,
        `on chain        ${r.chain.receipts} payments, ${r.chain.usdc} USDC`,
        `API ledger      ${r.ledger.settled} settled, ${r.ledger.usdc} USDC`,
        `matched         ${r.matched} of ${r.ledger.settled} ledger rows found on chain for the exact amount`,
        `not on ledger   ${r.unlisted.length} on-chain payments (test runs against other deployments)`,
        r.ok ? "OK: every payment the API claims is on chain." : `FAIL: ${r.missing.length} ledger rows are not backed by the chain:\n${r.missing.map((m) => `  ${m.tx} ledger ${m.ledgerAmount} chain ${m.chainAmount}`).join("\n")}`,
      ].join("\n"),
      r,
    );
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (cmd === "mcp") {
    const { runMcp } = await import("./mcp.js");
    return runMcp({ baseUrl, rpcUrl });
  }

  const api = createAfriRadar({
    signer: ["catalog", "search", "overview"].includes(cmd) ? undefined : await loadSigner(),
    baseUrl,
    rpcUrl,
    maxPerRequest: typeof flags.max === "string" ? Number(flags.max) : undefined,
    budget: typeof flags.budget === "string" ? Number(flags.budget) : undefined,
  });
  const receipt = (r: { usdc: number; explorer: string }) => `\npaid ${r.usdc} USDC  ${r.explorer}`;

  switch (cmd) {
    case "catalog": {
      const c = (await api.catalog()) as { dataWeek: string; payTo: string; products: { method: string; path: string; price: string; scheme: string; summary: string }[] };
      return out(`AfriRadar Data API, SEC week ${c.dataWeek}, pays ${c.payTo}\n` + c.products.map((p) => `${p.method.padEnd(4)} ${p.path.padEnd(38)} ${p.price.padEnd(7)} ${p.scheme}`).join("\n"), c);
    }
    case "overview":
      return out(JSON.stringify(await api.overview(), null, 2), await api.overview());
    case "search": {
      const r = await api.search(rest.join(" "));
      const lines = [
        ...r.results.map((f) => `${f.id.padEnd(55)} ${f.manager}`),
        ...(r.kenya ?? []).map((s) => `${`kenya ${s.id}`.padEnd(55)} ${s.name}`),
      ];
      return out(lines.join("\n") || "no match", r);
    }
    case "kenya": {
      const r = rest[0] ? await api.kenyaScheme(rest[0]) : await api.kenya();
      return out(JSON.stringify(r.data, null, 2) + receipt(r.receipt), r);
    }
    case "top": {
      const r = await api.top(rest[0] as Category, { by: flags.by as RankBy | undefined, limit: Number(flags.limit) || 10 });
      const d = r.data as { week: string; by: string; funds: { name: string; yieldYtd: number; navNgn: number }[] };
      return out(`week ${d.week}, by ${d.by}\n` + d.funds.map((f, i) => `${String(i + 1).padStart(2)}. ${f.name.padEnd(50)} ytd ${pct(f.yieldYtd).padStart(7)}  ${ngn(f.navNgn)}`).join("\n") + receipt(r.receipt), r);
    }
    case "category":
    case "fund":
    case "history":
    case "compare": {
      const r = cmd === "category" ? await api.category(rest[0] as Category) : cmd === "fund" ? await api.fund(rest[0]) : cmd === "history" ? await api.history(rest[0]) : await api.compare(rest);
      return out(JSON.stringify(r.data, null, 2) + receipt(r.receipt), r);
    }
    case "ask": {
      const r = await api.ask(rest.join(" "));
      const b = r.data.bill;
      const lines = [`base $0.001`, ...b.data.map((d) => `${d.tool} $${d.price / 1e6}`), `AI tokens ${b.tokens.prompt + b.tokens.completion} $${b.tokens.price / 1e6}`];
      return out(`${r.data.answer}\n\nbill: ${lines.join(" + ")} = $${b.total / 1e6} (ceiling $0.05, rest refunded)${receipt(r.receipt)}`, r);
    }
    default:
      console.error(`unknown command "${cmd}"\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof AfriRadarError ? `error ${e.status}: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
