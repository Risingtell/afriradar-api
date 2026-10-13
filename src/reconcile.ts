// Reads a settlement transaction straight from Solana and reports what it paid the treasury.
// Used when a facilitator answers "settlement_pending" (broadcast, confirmation not seen yet):
// the buyer has paid, so the server checks the chain instead of withholding what they bought.

export type ChainPayment = {
  status: "confirmed" | "failed" | "unknown";
  received: bigint; // micro-USDC credited to the treasury's token account by this transaction
  slot?: number;
};

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
type TxResult = {
  slot: number;
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
} | null;

/** Net USDC the treasury gained in one transaction, from the transaction's own token-balance metadata. */
export function treasuryDelta(tx: TxResult, treasuryOwner: string, mint: string): bigint {
  if (!tx?.meta) return 0n;
  const sum = (list: TokenBalance[] | undefined) =>
    (list ?? []).filter((b) => b.owner === treasuryOwner && b.mint === mint).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
}

export async function readPayment(
  rpc: Rpc,
  signature: string,
  treasuryOwner: string,
  mint: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ChainPayment> {
  const attempts = opts.attempts ?? 8;
  const delay = opts.delayMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      const tx = (await rpc("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as TxResult;
      if (tx) {
        if (tx.meta?.err) return { status: "failed", received: 0n, slot: tx.slot };
        return { status: "confirmed", received: treasuryDelta(tx, treasuryOwner, mint), slot: tx.slot };
      }
    } catch {
      // Rate limits and timeouts are exactly why we are here; keep trying until attempts run out.
    }
    if (i < attempts - 1) await sleep(delay * (i + 1));
  }
  return { status: "unknown", received: 0n };
}
