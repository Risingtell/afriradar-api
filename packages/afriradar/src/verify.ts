// Recounts AfriRadar's revenue from the Solana chain alone, then checks the API's public ledger
// against it. The rule it enforces: every payment the ledger lists as settled must exist on chain,
// paid to the treasury, for exactly the amount listed. The chain may hold more than the ledger
// (payments made to other deployments of the same treasury); the ledger may never hold more.

export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Which chain to recount. The ledger's rows and the treasury's receipts are read for that network only. */
export type Network = "devnet" | "mainnet";
const PUBLIC_RPC: Record<Network, string> = { devnet: "https://api.devnet.solana.com", mainnet: "https://api.mainnet-beta.solana.com" };

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type Batch = (calls: { method: string; params: unknown[] }[]) => Promise<unknown[]>;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429 && attempt < 6) {
        await pause(800 * (attempt + 1));
        continue; // reads are safe to retry
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    }
  };
}

/** JSON-RPC batch: many reads in one request, replies matched by id. Rate limits retry the whole batch (reads only). */
export function jsonRpcBatch(url: string, fetchImpl: typeof fetch = fetch): Batch {
  return async (calls) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }))) });
      const limited = res.status === 429;
      const body = limited ? null : ((await res.json().catch(() => null)) as { id: number; result?: unknown; error?: { message: string } }[] | null);
      const itemLimited = Array.isArray(body) && body.some((r) => r.error && /429|rate limit|too many/i.test(r.error.message));
      if ((limited || itemLimited) && attempt < 2) {
        await pause(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok || !Array.isArray(body)) throw new Error(`batch of ${calls.length}: HTTP ${res.status}`);
      const byId = new Map(body.map((r) => [r.id, r]));
      return calls.map((c, id) => {
        const r = byId.get(id);
        if (!r) throw new Error(`${c.method}: no reply in batch`);
        if (r.error) throw new Error(`${c.method}: ${r.error.message}`);
        return r.result;
      });
    }
  };
}

type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
type Tx = { slot: number; blockTime: number | null; meta: { err: unknown; preTokenBalances?: Balance[]; postTokenBalances?: Balance[] } | null } | null;

export type ChainReceipt = { tx: string; amount: number; slot: number; time: string | null };
export type VerifyReport = {
  network: Network;
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

export type Progress = (done: number, total: number) => void;

/** Every transaction that credited the treasury's USDC account, with the amount credited. */
export async function chainReceipts(
  rpc: Rpc,
  treasury: string,
  mint = USDC_DEVNET,
  maxPages = 20,
  opts: { batch?: Batch; batchSize?: number; onProgress?: Progress } = {},
): Promise<{ account: string; receipts: ChainReceipt[] }> {
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
  const txs = await fetchTransactions(sigs, { rpc, ...opts });
  const receipts: ChainReceipt[] = [];
  txs.forEach((tx, i) => {
    const r = receiptOf(tx, sigs[i], treasury, mint);
    if (r && r.amount > 0) receipts.push(r);
  });
  return { account, receipts };
}

type Reads = { rpc: Rpc; batch?: Batch; batchSize?: number; onProgress?: Progress };

/** Fetches transactions in batches. A rate-limited batch is retried at half the size, down to one at a time. */
async function fetchTransactions(sigs: string[], r: Reads): Promise<Tx[]> {
  const params = (sig: string) => [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }];
  const out: Tx[] = [];
  let size = r.batch ? Math.max(1, r.batchSize ?? 20) : 1;
  for (let i = 0; i < sigs.length; ) {
    const chunk = sigs.slice(i, i + size);
    try {
      const txs = size > 1 && r.batch ? await r.batch(chunk.map((sig) => ({ method: "getTransaction", params: params(sig) }))) : [await r.rpc("getTransaction", params(chunk[0]))];
      out.push(...(txs as Tx[]));
      i += chunk.length;
      r.onProgress?.(i, sigs.length);
    } catch (e) {
      if (size > 1 && /429|rate limit|too many/i.test(String(e))) {
        size = Math.max(1, size >> 1);
        continue;
      }
      throw e;
    }
  }
  return out;
}

/** What one transaction credited to the treasury's USDC balance; null if it failed or is unknown. */
function receiptOf(tx: Tx, sig: string, treasury: string, mint: string): ChainReceipt | null {
  if (!tx?.meta || tx.meta.err) return null;
  const sum = (l?: Balance[]) => (l ?? []).filter((b) => b.owner === treasury && b.mint === mint).reduce((a, b) => a + Number(b.uiTokenAmount.amount), 0);
  return { tx: sig, amount: sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances), slot: tx.slot, time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null };
}

type LedgerRow = { tx: string | null; status: string; amount: string };

/** The API's settled ledger rows on one network, newest first, deduplicated by tx. Pages until `max` rows or the end. */
async function settledRows(base: string, f: typeof fetch, network: Network, max = Infinity): Promise<LedgerRow[]> {
  const all: LedgerRow[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = (await (await f(`${base}/v1/payments?limit=200&offset=${offset}&network=${network}`)).json()) as { recent: LedgerRow[] };
    all.push(...page.recent);
    if (page.recent.length < 200 || all.filter((r) => r.status === "settled").length >= max) break;
  }
  // A payment arriving mid-scan shifts the pages by one, so the same row can appear twice: key by tx.
  return [...new Map(all.filter((r) => r.status === "settled" && r.tx).map((r) => [r.tx, r])).values()];
}

type Catalog = { payTo: string; asset: { mint: string }; networks?: { id: string; asset: { mint: string } }[] };
/** The treasury and the USDC mint it is paid in on `network`, as the API itself declares them. */
const catalogOf = async (base: string, f: typeof fetch, network: Network) => {
  const c = (await (await f(`${base}/v1`)).json()) as Catalog;
  const declared = c.networks?.find((n) => n.id === network)?.asset.mint;
  if (network === "mainnet" && !declared) throw new Error("this API does not sell on mainnet");
  return { payTo: c.payTo, mint: declared ?? c.asset.mint };
};
type Opts = { baseUrl?: string; network?: Network; rpcUrl?: string; fetch?: typeof fetch; batchSize?: number; onProgress?: Progress };
const setup = (opts: Opts) => {
  const f = opts.fetch ?? fetch;
  const network = opts.network ?? "devnet";
  const rpcUrl = opts.rpcUrl ?? PUBLIC_RPC[network];
  return { network, base: (opts.baseUrl ?? "https://api.afriradar.com").replace(/\/$/, ""), f, rpc: jsonRpc(rpcUrl, f), batch: jsonRpcBatch(rpcUrl, f) };
};

/** Full recount: every receipt the treasury ever had, against every settled ledger row. */
export async function verify(opts: Opts = {}): Promise<VerifyReport> {
  const { network, base, f, rpc, batch } = setup(opts);
  const catalog = await catalogOf(base, f, network);
  const ledger = await settledRows(base, f, network);
  const { account, receipts } = await chainReceipts(rpc, catalog.payTo, catalog.mint, 20, { batch, batchSize: opts.batchSize, onProgress: opts.onProgress });
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
    network,
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

export type RecentReport = { network: Network; treasury: string; checked: number; matched: number; missing: VerifyReport["missing"]; ok: boolean };

/** Quick check: reads only the latest `count` settled ledger rows from the chain and compares each amount. */
export async function verifyRecent(opts: Opts & { count?: number } = {}): Promise<RecentReport> {
  const { network, base, f, rpc, batch } = setup(opts);
  const catalog = await catalogOf(base, f, network);
  const rows = (await settledRows(base, f, network, opts.count ?? 50)).slice(0, opts.count ?? 50);
  const txs = await fetchTransactions(rows.map((r) => r.tx as string), { rpc, batch, batchSize: opts.batchSize, onProgress: opts.onProgress });
  const missing: VerifyReport["missing"] = [];
  rows.forEach((row, i) => {
    const onChain = receiptOf(txs[i], row.tx as string, catalog.payTo, catalog.mint);
    if (!onChain || onChain.amount !== Number(row.amount)) missing.push({ tx: row.tx as string, ledgerAmount: Number(row.amount), chainAmount: onChain?.amount ?? null });
  });
  return { network, treasury: catalog.payTo, checked: rows.length, matched: rows.length - missing.length, missing, ok: missing.length === 0 };
}
