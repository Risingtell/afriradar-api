// Keeps the API's data level with the website. The site publishes SEC's new week whenever its GitHub job
// lands (any time of day); the daily ingest alone would leave the paid API up to a day behind the free pages.
// The hourly cron calls catchUp(): one small read of the site's newest week, and an ingest only when the
// site is ahead and no catch-up ingest has run in the last 24 hours. /v1/status reports both weeks, so a gap
// is visible to anyone, not just to us.
//
// Two limits keep this inside D1's free 100,000 written rows a day: an ingest writes only rows that are new or
// changed (changedOnly in src/db.ts), and a catch-up ingest runs at most once in any 24 hours (ingest_runs).
// If the site is still ahead after that one try, the daily 06:17 UTC ingest and the next day's catch-up follow.
import type { Db } from "../db.js";
import { ingest } from "./ingest.js";
import { latestWeek } from "./queries.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const CATCH_UP_GAP_MS = 24 * 60 * 60 * 1000;

/** The newest SEC week the website has published, from its weekly-email.json; null if it cannot be read. */
export async function siteWeek(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/data/weekly-email.json?t=${Date.now()}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { as_of?: unknown };
    return typeof body?.as_of === "string" && ISO_DAY.test(body.as_of) ? body.as_of : null;
  } catch {
    return null;
  }
}

/** Records one ingest run; also how catchUp knows when it last ran. */
export async function recordRun(db: Db, run: { at: Date; kind: "catchup" | "daily"; site: string | null; api: string | null; changed: number; error?: string }) {
  await db.run(
    "INSERT INTO ingest_runs (at, kind, site_week, api_week, changed, error) VALUES (?, ?, ?, ?, ?, ?)",
    run.at.toISOString(), run.kind, run.site, run.api, run.changed, run.error ?? null,
  );
}

export type CatchUp = { site: string | null; api: string | null; ingested: boolean; changed: number; skipped?: "recent" };

/** Ingests the latest week when the site has a newer one, at most once in any 24 hours. */
export async function catchUp(db: Db, opts: { baseUrl: string; fetchImpl?: typeof fetch; now?: Date }): Promise<CatchUp> {
  const now = opts.now ?? new Date();
  const site = await siteWeek(opts.baseUrl, opts.fetchImpl);
  const before = await latestWeek(db);
  if (!site || (before && before >= site)) return { site, api: before, ingested: false, changed: 0 };
  const last = await db.first<{ at: string }>("SELECT at FROM ingest_runs WHERE kind = 'catchup' ORDER BY at DESC LIMIT 1");
  if (last && now.getTime() - Date.parse(last.at) < CATCH_UP_GAP_MS) {
    return { site, api: before, ingested: false, changed: 0, skipped: "recent" };
  }
  try {
    const r = await ingest(db, { baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
    const api = await latestWeek(db);
    await recordRun(db, { at: now, kind: "catchup", site, api, changed: r.changed });
    return { site, api, ingested: true, changed: r.changed };
  } catch (e) {
    // A failed try still counts as today's try, so a broken file cannot make every hour re-download it.
    await recordRun(db, { at: now, kind: "catchup", site, api: before, changed: 0, error: String((e as Error).message ?? e).slice(0, 300) });
    throw e;
  }
}
