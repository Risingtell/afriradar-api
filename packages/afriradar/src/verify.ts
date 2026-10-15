// Recounts AfriRadar's revenue from the Solana chain alone, then checks the API's public ledger
// against it. The rule it enforces: every payment the ledger lists as settled must exist on chain,
// paid to the treasury, for exactly the amount listed. The chain may hold more than the ledger
// (payments made to other deployments of the same treasury); the ledger may never hold more.

export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429 && attempt < 6) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue; // reads are safe to retry
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    }
  };
}

type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
type Tx = { slot: number; blockTime: number | null; meta: { err: unknown; preTokenBalances?: Balance[]; postTokenBalances?: Balance[] } | null } | null;

export type ChainReceipt = { tx: string; amount: number; slot: number; time: string | null };
export type VerifyReport = {
  treasury: string;
  tokenAccount: string;
  chain: { receipts: number; usdc: number };
  ledger: { settled: number; usdc: number };
  matched: number;
  /** Ledger rows the chain does not back up. Must be empty. */
  missing: { tx: string; ledgerAmount: number; chainAmount: number | null }[];
  /** On-chain receipts the ledger does not list (e.g. local test runs). Allowed. */
  unlisted: ChainReceipt[];
  ok: boolean;
};

async function tokenAccount(rpc: Rpc, owner: string, mint: string): Promise<string> {
  const r = (await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }])) as { value: { pubkey: string }[] };
  if (!r.value.length) throw new Error(`treasury ${owner} has no USDC account`);
  return r.value[0].pubkey;
}

/** Every transaction that credited the treasury's USDC account, with the amount credited. */
export async function chainReceipts(rpc: Rpc, treasury: string, mint = USDC_DEVNET, maxPages = 20): Promise<{ account: string; receipts: ChainReceipt[] }> {
  const account = await tokenAccount(rpc, treasury, mint);
  const sigs: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const batch = (await rpc("getSignaturesForAddress", [account, { limit: 1000, ...(before ? { before } : {}) }])) as { signature: string; err: unknown }[];
    sigs.push(...batch.filter((s) => !s.err).map((s) => s.signature));
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
    if (page === maxPages - 1) throw new Error(`more than ${maxPages * 1000} signatures; raise maxPages`);
  }
  const receipts: ChainReceipt[] = [];
  for (const sig of sigs) {
    const tx = (await rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as Tx;
    if (!tx?.meta || tx.meta.err) continue;
    const sum = (l?: Balance[]) => (l ?? []).filter((b) => b.owner === treasury && b.mint === mint).reduce((a, b) => a + Number(b.uiTokenAmount.amount), 0);
    const amount = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
    if (amount > 0) receipts.push({ tx: sig, amount, slot: tx.slot, time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null });
  }
  return { account, receipts };
}

export async function verify(opts: { baseUrl?: string; rpcUrl?: string; fetch?: typeof fetch } = {}): Promise<VerifyReport> {
  const base = (opts.baseUrl ?? "https://api.afriradar.com").replace(/\/$/, "");
  const f = opts.fetch ?? fetch;
  const catalog = (await (await f(`${base}/v1`)).json()) as { payTo: string; asset: { mint: string } };
  // Page through the whole ledger; stopping at the first page would under-count silently.
  const all: { tx: string | null; status: string; amount: string }[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = (await (await f(`${base}/v1/payments?limit=200&offset=${offset}`)).json()) as { recent: typeof all };
    all.push(...page.recent);
    if (page.recent.length < 200) break;
  }
  // A payment arriving mid-scan shifts the pages by one, so the same row can appear twice: key by tx.
  const ledger = [...new Map(all.filter((r) => r.status === "settled" && r.tx).map((r) => [r.tx, r])).values()];
  const rpc = jsonRpc(opts.rpcUrl ?? "https://api.devnet.solana.com", f);
  const { account, receipts } = await chainReceipts(rpc, catalog.payTo, catalog.asset.mint);
  const byTx = new Map(receipts.map((r) => [r.tx, r]));
  const missing: VerifyReport["missing"] = [];
  let matched = 0;
  for (const row of ledger) {
    const onChain = byTx.get(row.tx as string);
    if (onChain && onChain.amount === Number(row.amount)) matched++;
    else missing.push({ tx: row.tx as string, ledgerAmount: Number(row.amount), chainAmount: onChain?.amount ?? null });
  }
  const listed = new Set(ledger.map((r) => r.tx));
  return {
    treasury: catalog.payTo,
    tokenAccount: account,
    chain: { receipts: receipts.length, usdc: receipts.reduce((a, r) => a + r.amount, 0) / 1e6 },
    ledger: { settled: ledger.length, usdc: ledger.reduce((a, r) => a + Number(r.amount), 0) / 1e6 },
    matched,
    missing,
    unlisted: receipts.filter((r) => !listed.has(r.tx)),
    ok: missing.length === 0,
  };
}
