// "Top up from any chain": a one-time Aurora Intents deposit address that turns USDT or USDC on another
// chain into USDC in the visitor's own Solana wallet. The API quotes (POST /v1/topup/quote) and tracks
// the deposit (GET /v1/topup/status/:address); this page never talks to Aurora directly.
type Source = { id: string; chain: string; token: string; decimals: number; kind: "evm" | "tron" | "solana"; max: number };
type Quote = {
  send: { amount: string; token: string; chain: string; to: string | null; memo: string | null };
  receive: { usdc: string; atLeastUsdc: string; wallet: string | null };
  refundTo: string | null; estimatedSeconds: number | null; deadline: string | null; error?: string;
};
type Tx = { hash: string; explorer: string | null };
type Status = { status: string; done: boolean; message: string; originTxs: Tx[]; solanaTxs: Tx[]; error?: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const short = (s: string | null) => (!s ? "" : s.length > 14 ? `${s.slice(0, 6)}...${s.slice(-6)}` : s);
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POLL_MS = 8000; // stays under the API's 600 status checks an hour per visitor
const POLL_FOR_MS = 60 * 60_000;

let sources: Source[] = [];
let estimateTimer: number | undefined;
let estimateSeq = 0;
// Each deposit being tracked gets a new number; a reply for an older number is dropped.
let pollId = 0;
let pollTimer: number | undefined;

const current = () => sources.find((s) => s.id === $<HTMLSelectElement>("topup-from").value) ?? sources[0];
const kindOf = (s: Source) => s.kind;

function setStatus(text: string, kind: "" | "ok" | "bad" = "") {
  const s = $("topup-status");
  s.textContent = text;
  s.className = `out-status ${kind}`;
}

function syncFields() {
  const s = current();
  $("topup-token").textContent = s.token;
  $("topup-chain").textContent = s.chain;
  $("topup-refund-field").hidden = kindOf(s) === "solana";
  $<HTMLInputElement>("topup-refund").placeholder = kindOf(s) === "tron" ? "T..." : "0x...";
}

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = window.setTimeout(() => void estimate(), 500);
}

// A dry quote: Aurora prices the swap and creates no deposit address.
async function estimate() {
  const s = current();
  const seq = ++estimateSeq;
  const amount = $<HTMLInputElement>("topup-amount").value.trim();
  const line = $("topup-estimate");
  if (!amount) {
    line.textContent = "Type an amount for a live price.";
    return;
  }
  line.textContent = "Checking the live price...";
  const wallet = $<HTMLInputElement>("topup-wallet").value.trim();
  try {
    const res = await fetch("/v1/topup/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: s.id, amount, dry: true, ...(SOLANA.test(wallet) ? { wallet } : {}) }) });
    const q = (await res.json()) as Quote;
    if (seq !== estimateSeq) return; // a newer price is on its way
    line.innerHTML = res.ok
      ? `You get about <b>${esc(q.receive.usdc)} USDC</b> on Solana, at least ${esc(q.receive.atLeastUsdc)}${q.estimatedSeconds ? `, in about ${esc(q.estimatedSeconds)} seconds` : ""}.`
      : esc(q.error ?? `Could not price this (${res.status}).`);
  } catch (e) {
    if (seq === estimateSeq) line.textContent = `Could not price this: ${(e as Error).message}`;
  }
}

function stopPolling() {
  pollId++;
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

function renderDeposit(q: Quote) {
  const deadline = q.deadline ? new Date(q.deadline).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  $("topup-result").innerHTML = `
    <p class="answer">Send exactly <b>${esc(q.send.amount)} ${esc(q.send.token)}</b> on <b>${esc(q.send.chain)}</b> to this address:</p>
    <p class="deposit-address"><code>${esc(q.send.to)}</code><button class="btn btn--ghost" type="button" id="topup-copy">Copy</button></p>
    ${q.send.memo ? `<p class="small">Memo, required: <code>${esc(q.send.memo)}</code></p>` : ""}
    <table class="bill"><tbody>
      <tr><td>You receive about</td><td>${esc(q.receive.usdc)} USDC</td></tr>
      <tr><td>At least</td><td>${esc(q.receive.atLeastUsdc)} USDC</td></tr>
      <tr><td>Into your Solana wallet</td><td>${esc(short(q.receive.wallet))}</td></tr>
      <tr><td>Refunds go to</td><td>${esc(short(q.refundTo))}</td></tr>
      ${deadline ? `<tr><td>Send before</td><td>${esc(deadline)}</td></tr>` : ""}
    </tbody></table>
    <div class="receipt" id="topup-progress">Waiting for your deposit. This page checks every few seconds.</div>
    <p class="small muted">Send only ${esc(q.send.token)} on ${esc(q.send.chain)} to this address, and only once. Compare the address on your wallet's screen before you confirm.</p>`;
  $("topup-copy").addEventListener("click", async () => {
    const b = $<HTMLButtonElement>("topup-copy");
    try {
      await navigator.clipboard.writeText(q.send.to ?? "");
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select and copy it";
    }
  });
}

function renderProgress(st: Status) {
  const links = (list: Tx[], label: string) => list.filter((t) => t.explorer).map((t) => `<a href="${esc(t.explorer)}" target="_blank" rel="noopener">${label} ${esc(short(t.hash))}</a>`).join(" ");
  const box = $("topup-progress");
  box.innerHTML = [
    esc(st.message),
    st.originTxs.length ? links(st.originTxs, "Deposit tx") : "",
    st.solanaTxs.length ? links(st.solanaTxs, "Solana tx") : "",
    st.status === "SUCCESS" ? `<a href="#try">Pay on mainnet now: choose Mainnet and My wallet above.</a>` : "",
  ].filter(Boolean).join("<br>");
  box.className = `receipt${st.status === "REFUNDED" || st.status === "FAILED" ? " bad" : ""}`;
  setStatus(st.status === "SUCCESS" ? "Funded. Your wallet can pay on mainnet now." : st.message, st.status === "SUCCESS" ? "ok" : st.done ? "bad" : "");
}

// One check at a time: the next is scheduled only after the last reply, so replies never arrive out
// of order, and a reply for a deposit no longer shown is dropped.
function startPolling(address: string) {
  stopPolling();
  const id = pollId;
  const started = Date.now();
  const offerRecheck = (text: string) => {
    setStatus(text);
    $("topup-progress").insertAdjacentHTML("beforeend", `<br><button class="btn btn--ghost" type="button" id="topup-recheck">Check again</button>`);
    $("topup-recheck").addEventListener("click", () => startPolling(address));
  };
  const tick = async () => {
    if (id !== pollId) return;
    if (Date.now() - started > POLL_FOR_MS) return offerRecheck("Stopped checking after an hour. Your deposit is not affected.");
    try {
      const res = await fetch(`/v1/topup/status/${encodeURIComponent(address)}`);
      const st = (await res.json().catch(() => ({}))) as Status;
      if (id !== pollId) return;
      if (res.status === 400 || res.status === 404) {
        // Permanent: checking again cannot help.
        $("topup-progress").textContent = st.error ?? `This deposit cannot be tracked (${res.status}).`;
        $("topup-progress").className = "receipt bad";
        return setStatus("Stopped checking.", "bad");
      }
      if (res.ok) {
        renderProgress(st);
        if (st.done) return;
      }
      // Anything else (busy, limited, offline for a moment) is tried again below.
    } catch {
      if (id !== pollId) return;
    }
    pollTimer = window.setTimeout(() => void tick(), POLL_MS);
  };
  void tick();
}

async function go() {
  const s = current();
  const amount = $<HTMLInputElement>("topup-amount").value.trim();
  const wallet = $<HTMLInputElement>("topup-wallet").value.trim();
  const refundTo = kindOf(s) === "solana" ? "" : $<HTMLInputElement>("topup-refund").value.trim();
  if (!SOLANA.test(wallet)) return setStatus("Enter the Solana wallet that should receive the USDC.", "bad");
  if (kindOf(s) !== "solana" && !refundTo) return setStatus(`Enter your own ${s.chain} address, for refunds.`, "bad");
  const btn = $<HTMLButtonElement>("topup-go");
  btn.disabled = true;
  stopPolling();
  setStatus("Asking Aurora Intents for a deposit address...");
  try {
    const res = await fetch("/v1/topup/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: s.id, amount, wallet, ...(refundTo ? { refundTo } : {}) }) });
    const q = (await res.json()) as Quote;
    if (!res.ok || !q.send?.to) return setStatus(q.error ?? `Could not create an address (${res.status}).`, "bad");
    renderDeposit(q);
    setStatus("Waiting for your deposit.");
    startPolling(q.send.to);
  } catch (e) {
    setStatus(`Could not create an address: ${(e as Error).message}`, "bad");
  } finally {
    btn.disabled = false;
  }
}

/** Fills the receiving wallet with the wallet connected in the console, unless one is typed already. */
export function prefillTopupWallet(address: string) {
  const w = $<HTMLInputElement>("topup-wallet");
  if (w && !w.value.trim()) w.value = address;
}

export async function initTopup() {
  // The class also hides top-up hints the console adds to the page later.
  const hide = () => {
    $("topup").hidden = true;
    document.body.classList.add("no-topup");
  };
  try {
    const res = await fetch("/v1/topup");
    if (!res.ok) return hide(); // this deployment has no Aurora key
    sources = ((await res.json()) as { sources: Source[] }).sources;
  } catch {
    return hide();
  }
  $<HTMLSelectElement>("topup-from").innerHTML = sources.map((s) => `<option value="${esc(s.id)}">${esc(s.token)} on ${esc(s.chain)}</option>`).join("");
  syncFields();
  // Price only once the section is on screen, so page loads and crawlers spend no price checks.
  const section = $("topup");
  if ("IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      void estimate();
    });
    seen.observe(section);
  } else {
    void estimate();
  }
  $("topup-from").addEventListener("change", () => {
    syncFields();
    scheduleEstimate();
  });
  $("topup-amount").addEventListener("input", scheduleEstimate);
  $("topup-go").addEventListener("click", () => void go());
}
