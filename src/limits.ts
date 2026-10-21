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

export const hourOf = (d: Date) => d.toISOString().slice(0, 13);
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
