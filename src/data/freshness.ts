// Keeps the API's data level with the website. The site publishes SEC's new week whenever its GitHub job
// lands (any time of day); the daily ingest alone would leave the paid API up to a day behind the free pages.
// The hourly cron calls catchUp(): one small read of the site's newest week, and a full ingest only when the
// site is ahead. /v1/status reports both weeks, so a gap is visible to anyone, not just to us.
import type { Db } from "../db.js";
import { ingest } from "./ingest.js";
import { latestWeek } from "./queries.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

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

export type CatchUp = { site: string | null; api: string | null; ingested: boolean };

/** Ingests the latest week only when the site has a newer one than the API holds. */
export async function catchUp(db: Db, opts: { baseUrl: string; fetchImpl?: typeof fetch }): Promise<CatchUp> {
  const site = await siteWeek(opts.baseUrl, opts.fetchImpl);
  const before = await latestWeek(db);
  if (!site || (before && before >= site)) return { site, api: before, ingested: false };
  await ingest(db, { baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  return { site, api: await latestWeek(db), ingested: true };
}
