// /concordium: the page that registers AfriRadar's agents, step by step, from the owner's Concordium Browser
// Wallet. The page asks Concordium's registry service to build each call (it holds no keys), and the wallet
// signs and sends it; nothing secret ever reaches this page or this server. Each step's status is read back
// from the chain, so the page also shows anyone where registration stands.
import { OWNER } from "./agents.js";
import { CONCORDIUM } from "./registry.js";

export function registrationPage(): string {
  const net = CONCORDIUM.testnet;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AfriRadar agents on Concordium</title>
<meta name="description" content="AfriRadar's seller and buyer agents in the Concordium Agent Registry: the Solana wallets bound to a verified Concordium account, the badges, and the Agent Cards anchored on chain.">
<style>
  :root { --bg: #f6f4ef; --ink: #14181f; --soft: #5b6472; --line: #dcd7cc; --card: #fff; --ok: #137a4b; --bad: #b42318; --accent: #0b5cad; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1318; --ink: #e8edf3; --soft: #9aa6b4; --line: #27303b; --card: #161c23; --ok: #4ccb8a; --bad: #ff7b72; --accent: #6cb4ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 2rem; line-height: 1.15; margin: 0 0 8px; }
  h2 { font-size: 1.25rem; margin: 0 0 4px; }
  p { margin: 8px 0; }
  .soft { color: var(--soft); }
  a { color: var(--accent); }
  code { font: 13px/1.4 ui-monospace, Consolas, monospace; word-break: break-all; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 20px 0; }
  button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  button[disabled] { opacity: .45; cursor: not-allowed; }
  button.ghost { background: transparent; color: var(--accent); }
  .agent { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin: 18px 0; }
  .step { display: grid; grid-template-columns: 26px 1fr auto; gap: 10px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
  .step:first-of-type { border-top: 0; }
  .dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line); margin-top: 3px; }
  .dot.done { background: var(--ok); border-color: var(--ok); }
  .dot.bad { background: var(--bad); border-color: var(--bad); }
  .msg { margin-top: 4px; font-size: .93rem; }
  .msg.ok { color: var(--ok); } .msg.bad { color: var(--bad); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 10px 0 4px; font-size: .93rem; }
  dt { color: var(--soft); }
  dd { margin: 0; }
  @media (max-width: 560px) { .step { grid-template-columns: 22px 1fr; } .step button { grid-column: 2; justify-self: start; } dl { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <h1>AfriRadar agents on Concordium</h1>
  <p class="soft">AfriRadar sells fund data to AI agents over x402 on Solana. Concordium's Agent Registry says who stands behind a Solana wallet: its key is bound to a verified Concordium account (CIS-8, checked on chain), and the agent holds a badge (a CIS-8004 NFT) whose Agent Card is anchored by its SHA-256. This page registers AfriRadar's own two agents from the owner's Concordium Browser Wallet, and shows anyone where each step stands, read live from Concordium ${net.network}.</p>
  <div class="bar">
    <button id="connect">Connect Concordium wallet</button>
    <span id="who" class="soft">Not connected. Registering needs the owner account; reading needs nothing.</span>
  </div>
  <div id="agents"><p class="soft">Reading the registry…</p></div>
  <p class="soft">Registry contracts: CIS-8004 <code>${net.cis8004.index},${net.cis8004.subindex}</code> and CIS-8 <code>${net.cis8.index},${net.cis8.subindex}</code> on Concordium ${net.network}. Owner account <code>${OWNER}</code>. Machine-readable plan: <a href="/concordium/agents">/concordium/agents</a>. Check any wallet: <code>/v1/agents/&lt;solana wallet&gt;</code>.</p>
</main>
<script type="module">
import { detectConcordiumProvider } from "https://esm.sh/@concordium/browser-wallet-api-helpers@3.3.0";
import { AccountTransactionType, CcdAmount, ContractAddress, Energy, ReceiveName } from "https://esm.sh/@concordium/web-sdk@12.0.2";

const MCP = "https://agent-registry-mcp.concordium.com/mcp";
const NET = ${JSON.stringify(net.network)};
const EXPLORER = ${JSON.stringify(net.explorer)};
const OWNER = ${JSON.stringify(OWNER)};
const CIS8 = ${JSON.stringify(net.cis8)};
let plan = null, provider = null, account = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function tool(name, args) {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: { network: NET, ...args } } }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "registry error");
  const text = body.result?.content?.[0]?.text ?? "null";
  if (body.result?.isError) throw new Error(text.slice(0, 200));
  return JSON.parse(text);
}

async function status(a) {
  const ext = { kind: "Cis8", contract_address: CIS8, key: a.externalKey };
  const [bound, agent] = await Promise.all([
    tool("owner_of_key", { external_key: a.externalKey }).catch(() => null),
    tool("agent_by_external_reference", { external_reference: ext }).catch(() => null),
  ]);
  const owner = bound && (bound.owner_account || bound.owner || bound.account || (typeof bound === "string" ? bound : null));
  const rec = agent && (agent.agent || agent);
  let card = null;
  if (rec && rec.token_id !== undefined) card = await tool("verify_agent_card", { token_id: String(rec.token_id) }).catch(() => null);
  return { owner, rec: rec && rec.token_id !== undefined ? rec : null, card };
}

function stepRow(n, title, detail, state, action) {
  const dot = state === "done" ? "done" : state === "bad" ? "bad" : "";
  return '<div class="step"><div class="dot ' + dot + '"></div><div><strong>' + n + ". " + esc(title) + '</strong><div class="soft">' + detail + '</div><div class="msg" id="msg-' + action + '"></div></div>' +
    (action ? '<button data-action="' + action + '"' + (state === "done" ? " disabled" : "") + ">" + (state === "done" ? "Done" : "Approve in wallet") + "</button>" : "") + "</div>";
}

async function render() {
  plan = await (await fetch("/concordium/agents")).json();
  const blocks = [];
  for (const a of plan.agents) {
    const s = await status(a);
    a.status = s;
    const linked = s.owner === OWNER;
    const registered = !!s.rec;
    const pinned = registered && s.card && s.card.match === true && s.rec.agent_uri === a.agentUri && (s.rec.metadata_hash_hex || s.card.on_chain_hash_hex) === a.cardSha256;
    blocks.push('<section class="agent"><h2>' + esc(a.name) + '</h2><p class="soft">' + esc(a.role) + '</p><dl>' +
      "<dt>Solana wallet</dt><dd><code>" + esc(a.wallet) + "</code> (" + esc(a.solanaNetwork) + ")</dd>" +
      '<dt>Agent Card</dt><dd><a href="' + esc(a.agentUri) + '">' + esc(a.agentUri) + "</a><br><code>sha256 " + esc(a.cardSha256) + "</code></dd>" +
      (registered ? "<dt>Badge</dt><dd><code>" + esc(s.rec.token_address) + "</code> (token " + esc(s.rec.token_id) + ", " + esc(s.rec.status) + ')<br><a href="https://agent-registry-mcp.concordium.com/v1/badge-check/' + esc(s.rec.token_address) + '">Concordium badge check</a> · <a href="/v1/agents/' + esc(a.wallet) + "?network=" + (a.solanaNetwork.includes("5eykt") ? "mainnet" : "devnet") + '">AfriRadar check</a></dd>' : "") +
      "</dl>" +
      stepRow(1, "Bind the Solana wallet to the owner account", "CIS-8 <code>registerExternalKey</code>: the wallet's ed25519 signature over the canonical bytes, checked on chain. " + (linked ? "Bound to the owner." : s.owner ? "Bound to another account: " + esc(s.owner) : "Not bound yet."), linked ? "done" : "", a.id + ":bind") +
      stepRow(2, "Register the agent", "CIS-8004 <code>register</code>: mints the badge with this card's URL and hash, and the bound wallet as its external reference. " + (registered ? "Registered as token " + esc(s.rec.token_id) + "." : linked ? "Ready." : "Needs step 1 first."), registered ? "done" : "", linked && !registered ? a.id + ":register" : (registered ? a.id + ":register" : "")) +
      stepRow(3, "Pin the card that names its badge", "CIS-8004 <code>setAgentURI</code>: the card now carries its own token address, so its new SHA-256 is pinned on chain. " + (!registered ? "After step 2, once the server publishes the card with its token id." : pinned ? "The served card matches the on-chain hash." : a.tokenId ? "Ready: the served card's hash differs from the one on chain." : "Waiting for the server to publish the card with token " + esc(s.rec.token_id) + "."), pinned ? "done" : (s.card && s.card.match === false ? "bad" : ""), registered && a.tokenId && !pinned ? a.id + ":pin" : (pinned ? a.id + ":pin" : "")) +
      "</section>");
  }
  $("agents").innerHTML = blocks.join("");
  for (const b of document.querySelectorAll("button[data-action]")) b.onclick = () => act(b.dataset.action, b);
  for (const b of document.querySelectorAll("button[data-action]")) if (!account && !b.disabled) b.disabled = true;
}

async function send(contract, built, schemaKey) {
  const [name] = built.receive_name.split(".");
  return provider.sendTransaction(
    account,
    AccountTransactionType.Update,
    { amount: CcdAmount.zero(), address: ContractAddress.create(contract.index, contract.subindex), receiveName: ReceiveName.fromString(built.receive_name), maxContractExecutionEnergy: Energy.create(built.suggested_energy || 30000) },
    built.parameter_json,
    { type: "module", value: plan.schemas[schemaKey] },
  );
}

async function act(action, button) {
  const [id, what] = action.split(":");
  const a = plan.agents.find((x) => x.id === id);
  const msg = $("msg-" + action);
  button.disabled = true;
  msg.className = "msg"; msg.textContent = "Building the call…";
  try {
    let built, contract, schema;
    if (what === "bind") {
      built = await tool("build_cis8_register", { sender: account, external_key: a.externalKey, proof: a.proof, metadata: [{ key: "agent", value: a.name }] });
      contract = CIS8; schema = "cis8";
    } else if (what === "register") {
      built = await tool("build_register", { sender: account, agent_uri: a.agentUri, metadata_hash_hex: a.cardSha256, external_reference: { kind: "Cis8", contract_address: CIS8, key: a.externalKey } });
      contract = built.contract_address; schema = "cis8004";
    } else {
      built = await tool("build_set_agent_uri", { sender: account, token_id: String(a.status.rec.token_id), agent_uri: a.agentUri, metadata_hash_hex: a.cardSha256 });
      contract = built.contract_address; schema = "cis8004";
    }
    msg.textContent = "Approve it in your wallet…";
    const tx = await send(contract, built, schema);
    msg.className = "msg ok";
    msg.innerHTML = 'Sent: <a href="' + EXPLORER + "/?dcount=1&dentity=transaction&dhash=" + tx + '">' + tx + "</a>. Refreshing once it is in a block…";
    setTimeout(() => render().catch(() => undefined), 12000);
  } catch (e) {
    msg.className = "msg bad"; msg.textContent = String(e && e.message || e);
    button.disabled = false;
  }
}

$("connect").onclick = async () => {
  try {
    provider = await detectConcordiumProvider();
    account = await provider.connect();
    $("who").innerHTML = "Connected: <code>" + esc(account) + "</code>" + (account === OWNER ? " (the owner)" : " (not the owner account; registering needs " + esc(OWNER) + ")");
    if (account === OWNER) for (const b of document.querySelectorAll("button[data-action]")) if (b.textContent !== "Done") b.disabled = false;
  } catch (e) {
    $("who").textContent = "No Concordium Browser Wallet found, or it refused: " + (e && e.message || e);
  }
};
render().catch((e) => { $("agents").innerHTML = '<p class="msg bad">Could not read the registry: ' + esc(e.message || e) + "</p>"; });
</script>
</body>
</html>
`;
}

export const AGENT_ROLES: Record<string, string> = {
  seller: "AfriRadar itself. Its Solana wallet is the treasury every payment goes to, so a buyer can check the payTo address before paying.",
  buyer: "The demo buyer that pays the API every hour. Its payments show its badge in the public ledger.",
};
