// AfriRadar Data API page: live catalog, live ledger, and a console that pays either with the
// server's demo wallet (POST /demo/run) or with the visitor's own wallet over x402 in the browser.
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import type { TransactionModifyingSigner } from "@solana/kit";
import type { Wallet } from "@wallet-standard/base";
import { connect, disconnect, onWalletsChange, signsMainnetOnly, solanaWallets } from "./wallet.js";
import { verify, verifyRecent } from "../packages/afriradar/src/verify.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const usdc = (micro: number) => `$${(micro / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}...${s.slice(-6)}` : s);

// Devnet pays with free test USDC and is always on; mainnet pays real USDC and shows only when the API offers it.
const NETS = {
  devnet: { caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", chain: "solana:devnet", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", relay: "/rpc", publicRpc: "https://api.devnet.solana.com", label: "Solana devnet" },
  mainnet: { caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", chain: "solana:mainnet", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", relay: "/rpc/mainnet", publicRpc: "https://api.mainnet-beta.solana.com", label: "Solana mainnet" },
} as const;
type Net = keyof typeof NETS;
const explorer = (tx: string, n: Net) => `https://explorer.solana.com/tx/${tx}${n === "mainnet" ? "" : "?cluster=devnet"}`;

type Catalog = { dataWeek: string; payTo: string; networks?: { id: string }[]; categories: { id: string; name: string }[]; products: { id: string; method: string; path: string; scheme: string; price: string; summary: string; example: string }[] };
type LedgerRow = { tx: string | null; chain: Net; route: string; scheme: string; amount: string; usdc: number; payer: string | null; status: string; created_at: string; demo: boolean; monitor: boolean; explorer: string | null };
type Totals = { payments: number; usdc: number };

let mode: "ask" | "buy" = "ask";
let payWith: "demo" | "own" = "demo";
let net: Net = "devnet";
let own: { wallet: Wallet; signer: TransactionModifyingSigner; address: string } | null = null;
const WALLET_HINT: Record<Net, string> = {
  devnet: $("wallet-line").innerHTML,
  mainnet: "Pays real USDC on Solana mainnet from your own Phantom, Solflare, Backpack or MetaMask. A data request costs $0.001 to $0.005; a question locks at most $0.05 and refunds what it does not use. You need no SOL: the facilitator pays the network fee.",
};

// ---------- small safe markdown: escape first, then bold and pipe tables ----------
function renderAnswer(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const row = (s: string) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = row(l);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      i--;
      out.push(`<div class="table-scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^\s*[-*]\s+/.test(l)) out.push(`<p>&bull; ${inline(l.replace(/^\s*[-*]\s+/, ""))}</p>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join("");
  function inline(s: string) {
    return esc(s.replace(/^#+\s*/, "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }
}

// ---------- catalog, prices, categories ----------
async function loadCatalog() {
  const c = (await (await fetch("/v1")).json()) as Catalog;
  if (c.networks?.some((n) => n.id === "mainnet")) {
    $("net-field").hidden = false;
    $("recount-net-field").hidden = false;
    $("net-tag").textContent = "Solana mainnet + devnet";
  }
  $("price-grid").innerHTML = c.products
    .map((p) => `<div><span class="tag ${p.scheme === "upto" ? "tag--devnet" : "tag--live"}">${esc(p.scheme === "upto" ? "metered, capped" : "fixed price")}</span><span class="price">${esc(p.price)}${p.scheme === "upto" ? " max" : ""}</span><p class="route">${esc(p.method)} ${esc(p.path)}</p><p>${esc(p.summary)}</p></div>`)
    .join("");
  $<HTMLSelectElement>("category").innerHTML = c.categories.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  const o = (await (await fetch("/v1/overview")).json()) as { week: string; funds: number; categories: { navNgn: number }[]; kenya?: { quarter: string | null; schemes: number; aumKes: number } };
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const nav = o.categories.reduce((a, x) => a + x.navNgn, 0);
  $("st-funds").textContent = String(o.funds);
  $("st-nav").textContent = `₦${(nav / 1e12).toFixed(2)}trn`;
  $("st-week").textContent = day(o.week);
  if (o.kenya?.quarter && o.kenya.schemes) {
    $("st-kenya").textContent = `KES ${(o.kenya.aumKes / 1e9).toFixed(0)}bn`;
    $("st-kenya-label").textContent = `in ${o.kenya.schemes} Kenyan schemes, quarter ended ${day(o.kenya.quarter)}`;
  }
}

// ---------- ledger ----------
async function loadLedger() {
  try {
    const l = (await (await fetch("/v1/payments?limit=25&network=all")).json()) as { settled: Totals & { payers: number }; visitors: Totals & { wallets: number }; monitor: { payments: number }; networks?: Record<Net, Totals & { payers: number }>; recent: LedgerRow[] };
    $("st-payments").textContent = String(l.settled.payments);
    const main = l.networks?.mainnet;
    $("ledger-totals").innerHTML = `<span><b>${l.settled.payments}</b> settled</span><span><b>${l.settled.usdc.toFixed(6)}</b> USDC</span>${main?.payments ? `<span><b>${main.payments}</b> on mainnet, real USDC, from ${main.payers} wallets</span>` : ""}<span><b>${l.visitors.payments}</b> paid from ${l.visitors.wallets} visitors' own wallets</span><span><b>${l.monitor.payments}</b> hourly checks</span>`;
    $("ledger-rows").innerHTML = l.recent.length
      ? l.recent
          .map((r) => `<tr><td>${esc(r.created_at.replace("T", " ").slice(0, 19))}</td><td class="st-${esc(r.status)}">${esc(r.status)}</td><td>${esc(r.scheme)}</td><td>${r.usdc}</td><td>${esc(r.route)}</td><td>${r.payer ? esc(short(r.payer)) : ""}${r.demo ? ' <span class="tag tag--off">demo</span>' : ""}${r.monitor ? ' <span class="tag tag--off">monitor</span>' : ""}</td><td>${r.explorer ? `<a href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(short(r.tx ?? ""))}</a>` : ""}${r.chain === "mainnet" ? ' <span class="tag tag--live">mainnet</span>' : ""}</td></tr>`)
          .join("")
      : `<tr><td colspan="7">No payments yet. Make the first one above.</td></tr>`;
    // The hero shows a real purchase when there is one, not the hourly self-check: real USDC first.
    const real = (r: LedgerRow) => r.status === "settled" && !!r.tx && !r.monitor;
    const mainRows = main?.payments ? ((await (await fetch("/v1/payments?limit=10&network=mainnet")).json()) as { recent: LedgerRow[] }).recent : [];
    const last = mainRows.find(real) ?? l.recent.find(real) ?? l.recent.find((r) => r.status === "settled" && r.tx);
    if (last) {
      $("proof-amount").textContent = `${last.usdc} USDC`;
      $("proof-route").textContent = last.route;
      $("proof-when").textContent = `${last.created_at.replace("T", " ").slice(0, 16)} UTC`;
      const a = $<HTMLAnchorElement>("proof-tx");
      a.textContent = short(last.tx as string);
      a.href = last.explorer as string;
      $("proof-tag").textContent = last.chain === "mainnet" ? "mainnet" : "on chain";
    }
  } catch {
    $("proof-tag").textContent = "offline";
    $("proof-tag").className = "tag tag--off";
  }
}

// ---------- reliability ----------
type CheckRow = { at: string; kind: "data" | "ask"; ok: boolean; ms: number; explorer: string | null; detail: string | null };
type Tally = { runs: number; passed: number };
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

async function loadStatus() {
  try {
    const s = (await (await fetch("/v1/status")).json()) as { last: CheckRow | null; last7d: Tally & { data: Tally; ask: Tally }; payments7d: { settled: number; failed: number } };
    const tag = $("rel-tag");
    if (!s.last) {
      tag.textContent = "first run soon";
      $("proof-check").textContent = "hourly, first run at :41";
      $("rel-week").textContent = "The first check runs at 41 minutes past the hour.";
      return;
    }
    const [what, got] = s.last.kind === "ask" ? ["asked the analyst", "got an answer"] : ["bought a fund", "got the data back"];
    tag.textContent = s.last.ok ? "passing" : "failing";
    tag.className = `tag ${s.last.ok ? "tag--live" : "tag--devnet"}`;
    $("proof-check").textContent = `hourly, last ${s.last.ok ? "passed" : "failed"} ${s.last.at.slice(11, 16)} UTC`;
    $("rel-text").innerHTML = `Last check ${esc(utc(s.last.at))}: ${what} and ${s.last.ok ? `${got} in ${(s.last.ms / 1000).toFixed(1)} s` : `failed (${esc(s.last.detail ?? "unknown")})`}.${s.last.explorer ? ` <a href="${esc(s.last.explorer)}" target="_blank" rel="noopener">Transaction</a>.` : ""} Every hour our demo wallet pays for a fund through the normal x402 flow, and every six hours it also asks the analyst a question.`;
    const w = s.last7d;
    $("rel-week").textContent = `Last 7 days: ${w.passed} of ${w.runs} checks passed (data ${w.data.passed}/${w.data.runs}, analyst ${w.ask.passed}/${w.ask.runs}). All payments in that time: ${s.payments7d.settled} settled, ${s.payments7d.failed} failed and not charged.`;
  } catch {
    $("rel-tag").textContent = "offline";
  }
}

// ---------- proof: try to overcharge ----------
type Trial = { claimMicroUsdc: number; accepted: boolean; programLog: string | null; error: unknown };
async function runProof() {
  const btn = $<HTMLButtonElement>("run-proof");
  btn.disabled = true;
  for (const i of [0, 1]) {
    $(`trial-${i}`).textContent = "Running on Solana devnet...";
    $(`trial-${i}`).className = "verdict";
    $(`trial-${i}-log`).textContent = "";
  }
  try {
    const res = await fetch("/v1/proof/cap");
    const p = (await res.json()) as { trials?: Trial[]; verdict?: string; simulatedAt?: string; program?: string; error?: string };
    if (!res.ok || !p.trials) throw new Error(p.error ?? `HTTP ${res.status}`);
    p.trials.forEach((t, i) => {
      $(`trial-${i}`).textContent = t.accepted ? "Accepted: within the deposit" : "Refused by Solana";
      $(`trial-${i}`).className = `verdict ${t.accepted ? "ok" : "no"}`;
      $(`trial-${i}-log`).textContent = t.programLog ?? (t.accepted ? "The payment-channel program would pay this claim." : JSON.stringify(t.error));
    });
    const recorded = $<HTMLAnchorElement>("proof-recorded").href;
    $("proof-note").innerHTML = `${p.verdict === "enforced" ? "Enforced." : "NOT ENFORCED."} Simulated ${esc(utc(p.simulatedAt ?? ""))} against program <code>${esc(short(p.program ?? ""))}</code> with the buyer's real channel-open transaction; nothing was sent. The same attack was also sent for real on 18 October 2026 and rejected on chain: <a id="proof-recorded" href="${esc(recorded)}" target="_blank" rel="noopener">see the transaction</a>.`;
  } catch (e) {
    for (const i of [0, 1]) $(`trial-${i}`).textContent = "Could not run";
    $("trial-0-log").textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- recount the ledger from the chain, in this browser ----------
async function recount(all: boolean) {
  const buttons = [$<HTMLButtonElement>("recount-recent"), $<HTMLButtonElement>("recount-all")];
  buttons.forEach((b) => (b.disabled = true));
  const bar = $("recount-bar");
  const out = $("recount-result");
  const relay = $<HTMLSelectElement>("recount-rpc").value === "relay";
  const network = $<HTMLSelectElement>("recount-net").value as Net;
  const rpcUrl = relay ? `${location.origin}${NETS[network].relay}` : NETS[network].publicRpc;
  const via = relay ? "our relay" : "Solana's public RPC";
  bar.style.width = "0";
  out.textContent = `Reading ${NETS[network].label} through ${via}...`;
  const onProgress = (done: number, total: number) => {
    bar.style.width = `${Math.round((done / total) * 100)}%`;
    out.textContent = `Read ${done} of ${total} transactions through ${via}...`;
  };
  try {
    if (all) {
      const r = await verify({ baseUrl: location.origin, network, rpcUrl, batchSize: relay ? 20 : 5, onProgress });
      out.innerHTML = r.ok
        ? `<span class="ok-text">OK: all ${r.matched} settled ${network} payments in our ledger are on chain for the exact amount.</span> The treasury received ${r.chain.receipts} payments (${r.chain.usdc.toFixed(6)} USDC) on ${NETS[network].label} in total; ${r.unlisted.length} are not in this ledger${network === "devnet" ? ", from test runs against other deployments" : ""}.`
        : `<span class="bad-text">${r.missing.length} ledger rows do not match the chain.</span> First: ${esc(short(r.missing[0].tx))}.`;
    } else {
      const r = await verifyRecent({ baseUrl: location.origin, network, rpcUrl, count: 50, batchSize: relay ? 25 : 5, onProgress });
      out.innerHTML = r.ok
        ? `<span class="ok-text">OK: the latest ${r.checked} settled ${network} payments are on chain, each for exactly the amount listed.</span>`
        : `<span class="bad-text">${r.missing.length} of ${r.checked} do not match the chain.</span> First: ${esc(short(r.missing[0].tx))}.`;
    }
    bar.style.width = "100%";
  } catch (e) {
    out.innerHTML = `<span class="bad-text">Could not finish: ${esc((e as Error).message)}.</span> Try the other RPC, or <code>npx afriradar verify</code>.`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------- console state ----------
function setPressed(a: string, b: string, first: boolean) {
  $(a).setAttribute("aria-pressed", String(first));
  $(b).setAttribute("aria-pressed", String(!first));
}
function updateProductFields() {
  const p = $<HTMLSelectElement>("product").value;
  $("f-category").hidden = !(p === "top" || p === "category");
  $("f-fund").hidden = !(p === "fund" || p === "history" || p === "compare" || p === "kenyaScheme");
  const fund = $<HTMLInputElement>("fund");
  if (p === "kenyaScheme" && fund.value.includes("/")) fund.value = "sanlam";
  if (p !== "kenyaScheme" && !fund.value.includes("/")) fund.value = "money-market/aiico-money-market-fund";
}
function status(text: string, kind: "" | "ok" | "bad" = "") {
  const s = $("status");
  s.textContent = text;
  s.className = `out-status ${kind}`;
}

function renderWallets() {
  const box = $("wallet-buttons");
  if (own) {
    box.innerHTML = `<p class="wallet-line">Connected: ${esc(own.wallet.name)} ${esc(own.address)}</p><button class="btn btn--ghost" type="button" id="disconnect">Disconnect</button>`;
    $("disconnect").addEventListener("click", async () => {
      const w = own?.wallet;
      own = null;
      $("wallet-line").innerHTML = WALLET_HINT[net];
      $("faucet-box").innerHTML = "";
      renderWallets();
      if (w) await disconnect(w).catch(() => undefined);
    });
    void showBalance(own.address);
    return;
  }
  const all = solanaWallets();
  const ws = all.filter((w) => net === "mainnet" || !signsMainnetOnly(w));
  const mainnetOnly = net === "devnet" ? all.filter(signsMainnetOnly).map((w) => esc(w.name)).join(", ") : "";
  box.innerHTML = (ws.length
    ? ws.map((w, i) => `<button class="btn btn--ghost" type="button" data-w="${i}">Connect ${esc(w.name)}</button>`).join("")
    : net === "devnet"
      ? `<p class="wallet-line">No Solana wallet that can pay on devnet is turned on in this browser. Install or turn on Phantom, Solflare or Backpack, or use the demo wallet.</p>`
      : `<p class="wallet-line">No Solana wallet is turned on in this browser. Install or turn on Phantom, Solflare, Backpack or MetaMask.</p>`)
    + (mainnetOnly ? `<p class="wallet-line">${mainnetOnly} is not listed: it signs Solana payments on mainnet only, so it cannot pay here on devnet. Switch the network to mainnet to use it.</p>` : "");
  box.querySelectorAll<HTMLButtonElement>("button[data-w]").forEach((b) =>
    b.addEventListener("click", async () => {
      const w = ws[Number(b.dataset.w)];
      try {
        const { signer, account } = await connect(w, () => NETS[net].chain);
        own = { wallet: w, signer, address: account.address };
        renderWallets();
      } catch (e) {
        status(`Could not connect: ${(e as Error).message}`, "bad");
      }
    }),
  );
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = (await (await fetch(NETS[net].relay, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: T };
  return r.result;
}
async function showBalance(addr: string) {
  const n = net;
  try {
    const r = await rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[] }>("getTokenAccountsByOwner", [addr, { mint: NETS[n].mint }, { encoding: "jsonParsed" }]);
    if (n !== net) return; // the visitor switched network while this was loading
    const bal = r.value.reduce((a, t) => a + t.account.data.parsed.info.tokenAmount.uiAmount, 0);
    if (n === "mainnet") {
      $("wallet-line").innerHTML = bal > 0
        ? `Mainnet USDC balance: ${bal}. This pays real USDC. You need no SOL: the facilitator pays the network fee.`
        : `This wallet holds no USDC on Solana mainnet (address ${esc(addr)}). Add a little: $0.10 covers about 20 data requests.`;
      $("faucet-box").innerHTML = "";
      return;
    }
    $("wallet-line").innerHTML = bal > 0
      ? `Devnet USDC balance: ${bal}. You need no SOL: the facilitator pays the network fee.`
      : `This wallet has no devnet USDC. Get some free at <a href="https://faucet.circle.com" target="_blank" rel="noopener">faucet.circle.com</a> (Solana Devnet, address ${esc(addr)}), or from us below.`;
    renderFaucet(addr, bal);
  } catch {
    /* balance is a convenience; the payment itself reports any shortfall */
  }
}

// Test USDC from our demo wallet, for a connected wallet that has less than 1.
function renderFaucet(addr: string, balance: number) {
  const box = $("faucet-box");
  if (balance >= 1) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<button class="btn btn--ghost" type="button" id="faucet">Send me 0.25 test USDC</button>`;
  $("faucet").addEventListener("click", async () => {
    const b = $<HTMLButtonElement>("faucet");
    b.disabled = true;
    b.textContent = "Sending on Solana devnet...";
    try {
      const res = await fetch("/demo/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: addr }) });
      const r = (await res.json()) as { sent?: number; explorer?: string; error?: string; message?: string };
      box.innerHTML = r.sent
        ? `<p class="wallet-line">Sent ${r.sent} test USDC. <a href="${esc(r.explorer)}" target="_blank" rel="noopener">Transaction</a>. You can pay now.</p>`
        : `<p class="wallet-line">${esc(r.error ?? r.message ?? `HTTP ${res.status}`)}${r.explorer ? ` <a href="${esc(r.explorer)}" target="_blank" rel="noopener">Transaction</a>` : ""}</p>`;
      if (r.sent && own) void showBalance(own.address);
    } catch (e) {
      box.innerHTML = `<p class="wallet-line">Could not send: ${esc((e as Error).message)}</p>`;
    }
  });
}

// ---------- running ----------
function requestFor(): { product: string; path: string; init?: RequestInit; params: Record<string, string>; question?: string } {
  if (mode === "ask") {
    const question = $<HTMLTextAreaElement>("question").value.trim();
    return { product: "ask", path: "/v1/ask", question, params: {}, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) } };
  }
  const product = $<HTMLSelectElement>("product").value;
  const category = $<HTMLSelectElement>("category").value;
  const id = $<HTMLInputElement>("fund").value.trim();
  const params: Record<string, string> = { category, id, ids: id.includes(",") ? id : `${id},money-market/first-ally-money-market-fund`, limit: "5" };
  const path = {
    top: `/v1/top/${category}?by=yield_ytd&limit=5`,
    category: `/v1/categories/${category}`,
    fund: `/v1/funds/${id}`,
    history: `/v1/funds/${id}/history`,
    compare: `/v1/compare?ids=${params.ids}`,
    kenya: "/v1/kenya/unit-trusts",
    kenyaScheme: `/v1/kenya/unit-trusts/${id}`,
  }[product] as string;
  return { product, path, params };
}

type Settled = { success?: boolean; transaction?: string; amount?: string; payer?: string; errorReason?: string };

function renderResult(data: unknown, receipt: Settled | null, payer: string, n: Net, agreed?: number) {
  const d = data as { answer?: string; bill?: { base: number; data: { tool: string; price: number }[]; tokens: { prompt: number; completion: number; price: number }; total: number; ceiling: number }; week?: string; error?: string };
  let html = "";
  if (d?.answer && d.bill) {
    const b = d.bill;
    html += `<div class="answer">${renderAnswer(d.answer)}</div>`;
    html += `<table class="bill"><tbody><tr><td>Base fee</td><td>${usdc(b.base)}</td></tr>${b.data.map((x) => `<tr><td>Data: ${esc(x.tool)}</td><td>${usdc(x.price)}</td></tr>`).join("")}<tr><td>AI tokens (${b.tokens.prompt + b.tokens.completion})</td><td>${usdc(b.tokens.price)}</td></tr><tr class="total"><td>Charged</td><td>${usdc(b.total)}</td></tr><tr class="refund"><td>Refunded from the ${usdc(b.ceiling)} deposit</td><td>${usdc(b.ceiling - b.total)}</td></tr></tbody></table>`;
  } else if (d?.error) {
    html += `<p class="answer">${esc(d.error)}</p>`;
  } else {
    html += `<pre class="json">${esc(JSON.stringify(data, null, 2))}</pre>`;
  }
  if (receipt?.transaction) {
    const amount = receipt.amount !== undefined ? Number(receipt.amount) : agreed;
    html += `<div class="receipt">Settled on ${NETS[n].label}${amount !== undefined ? `: ${usdc(amount)} ${n === "mainnet" ? "real " : ""}USDC` : ""}<br>payer ${esc(payer)}<br>tx <a href="${esc(explorer(receipt.transaction, n))}" target="_blank" rel="noopener">${esc(receipt.transaction)}</a></div>`;
  } else if (receipt) {
    html += `<div class="receipt bad">Not charged: ${esc(receipt.errorReason ?? "request failed")}</div>`;
  }
  $("result").innerHTML = html;
}

async function run() {
  const btn = $<HTMLButtonElement>("run");
  const req = requestFor();
  if (req.product === "ask" && (req.question ?? "").length < 3) return status("Type a question first.", "bad");
  const n = net;
  btn.disabled = true;
  status(payWith === "demo" ? "Paying with the demo wallet and waiting for Solana..." : `Waiting for your wallet to sign${n === "mainnet" ? " a real USDC payment" : ""}...`);
  $("result").innerHTML = `<p class="muted">${esc(req.product === "ask" ? "The analyst is buying data and writing. This takes about 10 to 25 seconds." : `Settling on ${NETS[n].label}.`)}</p>`;
  try {
    if (payWith === "demo") {
      const res = await fetch("/demo/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: req.product, question: req.question, params: req.params }) });
      const body = (await res.json()) as { data?: unknown; receipt?: Settled; payer?: string; error?: string; status?: number };
      if (!res.ok && !body.data) {
        status(body.error ?? `Failed (${res.status}). Not charged.`, "bad");
        $("result").innerHTML = `<p class="answer">${esc(body.error ?? "")}</p>`;
        return;
      }
      renderResult(body.data, body.receipt ?? null, body.payer ?? "demo wallet", "devnet", agreedPrice(req.product));
      status(body.receipt?.success ? "Paid and delivered." : "Not charged.", body.receipt?.success ? "ok" : "bad");
    } else {
      if (!own) return status("Connect a wallet first, or switch to the demo wallet.", "bad");
      // Registered for the chosen network only, so a wallet never pays on the other one.
      const rpcUrl = `${location.origin}${NETS[n].relay}`;
      const client = new x402Client()
        .register(NETS[n].caip2 as `${string}:${string}`, new ExactSvmScheme(own.signer, { rpcUrl }))
        .register(NETS[n].caip2 as `${string}:${string}`, new UptoSvmScheme(own.signer, { rpcUrl }))
        .setSpendControls({ maxAmountPerPayment: "$0.05" });
      let agreed: number | undefined;
      client.onAfterPaymentCreation(async ({ selectedRequirements }) => {
        agreed = Number(selectedRequirements.amount);
        status("Signed. Settling on Solana...");
      });
      const res = await wrapFetchWithPayment(fetch, client)(req.path, req.init);
      const header = res.headers.get("PAYMENT-RESPONSE");
      const receipt = header ? (decodePaymentResponseHeader(header) as Settled) : null;
      const data = await res.json().catch(() => null);
      renderResult(data, receipt, own.address, n, receipt?.amount ? undefined : agreed);
      status(res.ok && receipt?.success ? "Paid from your wallet and delivered." : `Not charged (${res.status}).`, res.ok ? "ok" : "bad");
      void showBalance(own.address);
    }
  } catch (e) {
    status(`Failed: ${(e as Error).message}`, "bad");
  } finally {
    btn.disabled = false;
    void loadLedger();
  }
}

const PRICES: Record<string, number> = { top: 2000, category: 2000, fund: 1000, history: 5000, compare: 3000, kenya: 2000, kenyaScheme: 1000 };
const agreedPrice = (p: string) => PRICES[p];

let searchTimer: number | undefined;
$("fund").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    const q = $<HTMLInputElement>("fund").value.trim();
    if (q.length < 2 || q.includes("/")) return;
    const r = (await (await fetch(`/v1/search?q=${encodeURIComponent(q)}`)).json()) as { results: { id: string; name: string }[] };
    $("fund-list").innerHTML = r.results.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  }, 250);
});
$("mode-ask").addEventListener("click", () => { mode = "ask"; setPressed("mode-ask", "mode-buy", true); $("ask-fields").hidden = false; $("buy-fields").hidden = true; });
$("mode-buy").addEventListener("click", () => { mode = "buy"; setPressed("mode-ask", "mode-buy", false); $("ask-fields").hidden = true; $("buy-fields").hidden = false; updateProductFields(); });
$("pay-demo").addEventListener("click", () => { payWith = "demo"; setPressed("pay-demo", "pay-own", true); $("own-wallet").hidden = true; $("demo-line").hidden = false; });
$("pay-own").addEventListener("click", () => { payWith = "own"; setPressed("pay-demo", "pay-own", false); $("own-wallet").hidden = false; $("demo-line").hidden = true; renderWallets(); });
// Mainnet has no demo wallet: real USDC comes only from the visitor's own wallet.
function setNet(n: Net) {
  if (n === net) return;
  net = n;
  setPressed("net-devnet", "net-mainnet", n === "devnet");
  $("pay-demo").hidden = n === "mainnet";
  if (n === "mainnet") {
    payWith = "own";
    setPressed("pay-demo", "pay-own", false);
    $("own-wallet").hidden = false;
    $("demo-line").hidden = true;
  }
  // A wallet that signs on mainnet only cannot stay connected for devnet.
  if (own && n === "devnet" && signsMainnetOnly(own.wallet)) {
    void disconnect(own.wallet).catch(() => undefined);
    own = null;
  }
  $("faucet-box").innerHTML = "";
  if (!own) $("wallet-line").innerHTML = WALLET_HINT[n];
  if (payWith === "own") renderWallets();
}
$("net-devnet").addEventListener("click", () => setNet("devnet"));
$("net-mainnet").addEventListener("click", () => setNet("mainnet"));
$("product").addEventListener("change", updateProductFields);
$("presets").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { $<HTMLTextAreaElement>("question").value = b.textContent ?? ""; }));
$("run").addEventListener("click", () => void run());
onWalletsChange(() => { if (payWith === "own") renderWallets(); });

void loadCatalog();
$("run-proof").addEventListener("click", () => void runProof());
$("recount-recent").addEventListener("click", () => void recount(false));
$("recount-all").addEventListener("click", () => void recount(true));
void loadLedger();
void loadStatus();
setInterval(() => void loadLedger(), 20000);
setInterval(() => void loadStatus(), 120000);
