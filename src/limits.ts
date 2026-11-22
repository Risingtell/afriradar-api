// Fixed-window counters in the kv table, for the free endpoints that spend something of ours
// (demo payments, faucet USDC, RPC simulations). One upsert each, so concurrent isolates cannot
// overshoot by much.
import type { Db } from "./db.js";

/** Adds one to the counter `ns`/`key` and returns the new count. */
export async function bump(db: Db, ns: string, key: string, now: Date): Promise<number> {
  await db.run(
    `INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, '1', ?)
     ON CONFLICT (ns, k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`,
    ns, key, now.toISOString(),
  );
  return Number((await db.first<{ v: string }>("SELECT v FROM kv WHERE ns = ? AND k = ?", ns, key))?.v ?? 0);
}

/** The rate-limit counters above: each key names its own hour or day, so a row older than that is never read again. */
const COUNTER_NAMESPACES = ["aurora", "demo", "faucet", "mainnet-ask", "proof", "redeem", "topup-dry", "topup-quote", "topup-status"] as const;

/** Deletes rate-limit counters last touched over two days ago (one row per visitor and window would otherwise stay forever). */
export async function sweepCounters(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  return (await db.run(`DELETE FROM kv WHERE ns IN (${COUNTER_NAMESPACES.map(() => "?").join(", ")}) AND updated_at < ?`, ...COUNTER_NAMESPACES, cutoff)).changes;
}

export const hourOf = (d: Date) => d.toISOString().slice(0, 13);
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
