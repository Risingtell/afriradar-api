// One mainnet send at a time per paying account (see PayerLock in netfee.ts for why), kept in the kv
// table so every Worker isolate sees the same lock. k is the account; v is JSON: the transaction's
// fingerprint `fp`, the `holder` (one settle attempt) that took it and, once a send may still land,
// `kept`; updated_at is when it was taken. A lock runs out on its own `ttlMs` after that, so a
// Worker that dies mid-settlement cannot block an account for longer.
import type { Db } from "./db.js";
import type { Acquired, PayerLock } from "./netfee.js";

/**
 * Longer than a kept transaction can still land: a Solana blockhash lives 150 blocks, about 60 to
 * 70 seconds, counted from when the buyer's wallet fetched it, before we ever see the payment.
 */
export const PAYER_LOCK_TTL_MS = 90_000;

const iso = (ms: number) => new Date(ms).toISOString();

export function payerLock(db: Db, ttlMs = PAYER_LOCK_TTL_MS, now: () => number = Date.now): PayerLock {
  /** What a held lock means for an attempt of transaction `fp`: join it (kept, same transaction) or wait. */
  const heldBy = (held: { fp: string | null; kept: number | null; updated_at: string }, fp: string, t: number): Acquired => {
    const kept = held.kept === 1;
    const same = held.fp === fp;
    // Joins only a kept lock of the same transaction, and writes nothing, so it never lasts longer.
    if (kept && same) return { role: "joined" };
    return { role: "busy", kept, same, remainingMs: Math.max(0, Date.parse(held.updated_at) + ttlMs - t) };
  };
  /** The updated_at of a lock that runs out `afterMs` from now. */
  const runsOutIn = (afterMs: number) => iso(now() - ttlMs + afterMs - 1);
  return {
    async acquire(account, fp, holder) {
      const t = now();
      // One query while the lock is held (a Worker on the free plan gets 50 per request), two to take it.
      const read = () => db.first<{ fp: string | null; kept: number | null; updated_at: string }>(
        "SELECT json_extract(v, '$.fp') AS fp, json_extract(v, '$.kept') AS kept, updated_at FROM kv WHERE ns = 'payer-lock' AND k = ?",
        account,
      );
      const held = await read();
      if (held && Date.parse(held.updated_at) >= t - ttlMs) return heldBy(held, fp, t);
      // Free, or its holder's time ran out: take it, unless another take gets there first.
      const { changes } = await db.run(
        `INSERT INTO kv (ns, k, v, updated_at) VALUES ('payer-lock', ?, json_object('fp', ?, 'holder', ?), ?)
         ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at WHERE kv.updated_at < ?`,
        account, fp, holder, iso(t), iso(t - ttlMs),
      );
      if (changes === 1) return { role: "took" };
      // Lost the race, so another attempt holds it: busy (or joined, if the winner already keeps it for
      // this same transaction), and busy if a second read fails.
      const winner = await read().catch(() => null);
      return winner ? heldBy(winner, fp, t) : { role: "busy", kept: false, same: false, remainingMs: ttlMs };
    },
    async release(account, holder) {
      const at = runsOutIn(0);
      await db.run(
        `UPDATE kv SET updated_at = ? WHERE ns = 'payer-lock' AND k = ? AND json_extract(v, '$.holder') = ?
         AND json_extract(v, '$.kept') IS NULL AND updated_at > ?`,
        at, account, holder, at,
      );
    },
    async landed(account, fp, afterMs) {
      const at = runsOutIn(afterMs);
      await db.run(
        "UPDATE kv SET updated_at = ? WHERE ns = 'payer-lock' AND k = ? AND json_extract(v, '$.fp') = ? AND updated_at > ?",
        at, account, fp, at,
      );
    },
    async keep(account, fp, holder) {
      await db.run(
        "UPDATE kv SET v = json_set(v, '$.kept', 1) WHERE ns = 'payer-lock' AND k = ? AND json_extract(v, '$.fp') = ? AND json_extract(v, '$.holder') = ?",
        account, fp, holder,
      );
    },
  };
}

/** Deletes locks that ran out over a day ago (one row per paying account would otherwise stay forever). */
export async function sweepPayerLocks(db: Db, now: number): Promise<number> {
  return (await db.run("DELETE FROM kv WHERE ns = 'payer-lock' AND updated_at < ?", iso(now - PAYER_LOCK_TTL_MS - 86_400_000))).changes;
}
