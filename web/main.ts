// AfriRadar Data API page: live catalog, live ledger, and a console that pays either with the
// server's demo wallet (POST /demo/run) or with the visitor's own wallet over x402 in the browser.
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import type { TransactionModifyingSigner } from "@solana/kit";
import type { Wallet } from "@wallet-standard/base";
import { connect, onWalletsChange, solanaWallets } from "./wallet.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const usdc = (micro: number) => `$${(micro / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}...${s.slice(-6)}` : s);
const explorer = (tx: string) => `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

type Catalog = { dataWeek: string; payTo: string; categories: { id: string; name: string }[]; products: { id: string; method: string; path: string; scheme: string; price: string; summary: string; example: string }[] };
type LedgerRow = { tx: string | null; route: string; scheme: string; amount: string; usdc: number; payer: string | null; status: string; created_at: string; demo: boolean; explorer: string | null };

let mode: "ask" | "buy" = "ask";
let payWith: "demo" | "own" = "demo";
let own: { wallet: Wallet; signer: TransactionModifyingSigner; address: string } | null = null;

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
  $("price-grid").innerHTML = c.products
    .map((p) => `<div><span class="tag ${p.scheme === "upto" ? "tag--devnet" : "tag--live"}">${esc(p.scheme === "upto" ? "metered, capped" : "fixed price")}</span><span class="price">${esc(p.price)}${p.scheme === "upto" ? " max" : ""}</span><p class="route">${esc(p.method)} ${esc(p.path)}</p><p>${esc(p.summary)}</p></div>`)
    .join("");
  $<HTMLSelectElement>("category").innerHTML = c.categories.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  const o = (await (await fetch("/v1/overview")).json()) as { week: string; funds: number; categories: { navNgn: number; unitholders: number }[] };
  const nav = o.categories.reduce((a, x) => a + x.navNgn, 0);
  const holders = o.categories.reduce((a, x) => a + x.unitholders, 0);
  $("st-funds").textContent = String(o.funds);
  $("st-nav").textContent = `₦${(nav / 1e12).toFixed(2)}trn`;
  $("st-holders").textContent = `${(holders / 1e6).toFixed(1)}m`;
  $("st-week").textContent = new Date(`${o.week}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// ---------- ledger ----------
async function loadLedger() {
  try {
    const l = (await (await fetch("/v1/payments?limit=25")).json()) as { settled: { payments: number; usdc: number; payers: number }; recent: LedgerRow[] };
    $("st-payments").textContent = String(l.settled.payments);
    $("ledger-totals").innerHTML = `<span><b>${l.settled.payments}</b> settled</span><span><b>${l.settled.usdc.toFixed(6)}</b> USDC</span><span><b>${l.settled.payers}</b> paying wallets</span>`;
    $("ledger-rows").innerHTML = l.recent.length
      ? l.recent
          .map((r) => `<tr><td>${esc(r.created_at.replace("T", " ").slice(0, 19))}</td><td class="st-${esc(r.status)}">${esc(r.status)}</td><td>${esc(r.scheme)}</td><td>${r.usdc}</td><td>${esc(r.route)}</td><td>${r.payer ? esc(short(r.payer)) : ""}${r.demo ? ' <span class="tag tag--off">demo</span>' : ""}</td><td>${r.explorer ? `<a href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(short(r.tx ?? ""))}</a>` : ""}</td></tr>`)
          .join("")
      : `<tr><td colspan="7">No payments yet. Make the first one above.</td></tr>`;
    const last = l.recent.find((r) => r.status === "settled" && r.tx);
    if (last) {
      $("proof-amount").textContent = `${last.usdc} USDC`;
      $("proof-route").textContent = last.route;
      $("proof-when").textContent = `${last.created_at.replace("T", " ").slice(0, 16)} UTC`;
      const a = $<HTMLAnchorElement>("proof-tx");
      a.textContent = short(last.tx as string);
      a.href = last.explorer as string;
      $("proof-tag").textContent = "on chain";
    }
  } catch {
    $("proof-tag").textContent = "offline";
    $("proof-tag").className = "tag tag--off";
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
    box.innerHTML = `<p class="wallet-line">Connected: ${esc(own.wallet.name)} ${esc(own.address)}</p>`;
    void showBalance(own.address);
    return;
  }
  const ws = solanaWallets();
  box.innerHTML = ws.length
    ? ws.map((w, i) => `<button class="btn btn--ghost" type="button" data-w="${i}">Connect ${esc(w.name)}</button>`).join("")
    : `<p class="wallet-line">No Solana wallet found in this browser. Install Phantom or Solflare, or use the demo wallet.</p>`;
  box.querySelectorAll<HTMLButtonElement>("button[data-w]").forEach((b) =>
    b.addEventListener("click", async () => {
      const w = ws[Number(b.dataset.w)];
      try {
        const { signer, account } = await connect(w);
        own = { wallet: w, signer, address: account.address };
        renderWallets();
      } catch (e) {
        status(`Could not connect: ${(e as Error).message}`, "bad");
      }
    }),
  );
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = (await (await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: T };
  return r.result;
}
async function showBalance(addr: string) {
  try {
    const r = await rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[] }>("getTokenAccountsByOwner", [addr, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
    const bal = r.value.reduce((a, t) => a + t.account.data.parsed.info.tokenAmount.uiAmount, 0);
    $("wallet-line").innerHTML = bal > 0
      ? `Devnet USDC balance: ${bal}. You need no SOL: the facilitator pays the network fee.`
      : `This wallet has no devnet USDC. Get some free at <a href="https://faucet.circle.com" target="_blank" rel="noopener">faucet.circle.com</a> (Solana Devnet, address ${esc(addr)}).`;
  } catch {
    /* balance is a convenience; the payment itself reports any shortfall */
  }
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

function renderResult(data: unknown, receipt: Settled | null, payer: string, agreed?: number) {
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
    html += `<div class="receipt">Settled on Solana devnet${amount !== undefined ? `: ${usdc(amount)} USDC` : ""}<br>payer ${esc(payer)}<br>tx <a href="${esc(explorer(receipt.transaction))}" target="_blank" rel="noopener">${esc(receipt.transaction)}</a></div>`;
  } else if (receipt) {
    html += `<div class="receipt bad">Not charged: ${esc(receipt.errorReason ?? "request failed")}</div>`;
  }
  $("result").innerHTML = html;
}

async function run() {
  const btn = $<HTMLButtonElement>("run");
  const req = requestFor();
  if (req.product === "ask" && (req.question ?? "").length < 3) return status("Type a question first.", "bad");
  btn.disabled = true;
  status(payWith === "demo" ? "Paying with the demo wallet and waiting for Solana..." : "Waiting for your wallet to sign...");
  $("result").innerHTML = `<p class="muted">${esc(req.product === "ask" ? "The analyst is buying data and writing. This takes about 10 to 25 seconds." : "Settling on Solana devnet.")}</p>`;
  try {
    if (payWith === "demo") {
      const res = await fetch("/demo/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: req.product, question: req.question, params: req.params }) });
      const body = (await res.json()) as { data?: unknown; receipt?: Settled; payer?: string; error?: string; status?: number };
      if (!res.ok && !body.data) {
        status(body.error ?? `Failed (${res.status}). Not charged.`, "bad");
        $("result").innerHTML = `<p class="answer">${esc(body.error ?? "")}</p>`;
        return;
      }
      renderResult(body.data, body.receipt ?? null, body.payer ?? "demo wallet", agreedPrice(req.product));
      status(body.receipt?.success ? "Paid and delivered." : "Not charged.", body.receipt?.success ? "ok" : "bad");
    } else {
      if (!own) return status("Connect a wallet first, or switch to the demo wallet.", "bad");
      const client = new x402Client()
        .register("solana:*", new ExactSvmScheme(own.signer, { rpcUrl: `${location.origin}/rpc` }))
        .register("solana:*", new UptoSvmScheme(own.signer, { rpcUrl: `${location.origin}/rpc` }))
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
      renderResult(data, receipt, own.address, receipt?.amount ? undefined : agreed);
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

const PRICES: Record<string, number> = { top: 2000, category: 2000, fund: 1000, history: 5000, compare: 3000 };
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
$("product").addEventListener("change", updateProductFields);
$("presets").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { $<HTMLTextAreaElement>("question").value = b.textContent ?? ""; }));
$("run").addEventListener("click", () => void run());
onWalletsChange(() => { if (payWith === "own") renderWallets(); });

void loadCatalog();
void loadLedger();
setInterval(() => void loadLedger(), 20000);
