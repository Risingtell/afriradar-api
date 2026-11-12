// The hourly catch-up and the write budget: ingest only when the website has a newer SEC week, at most once a
// day, and write only rows that are new or changed (D1's free plan allows 100,000 written rows a day).
import { describe, expect, it } from "vitest";
import { catchUp, CATCH_UP_GAP_MS, siteWeek } from "../src/data/freshness.js";
import { ingest } from "../src/data/ingest.js";
import { ingestKenya } from "../src/data/kenya.js";
import { latestWeek } from "../src/data/queries.js";
import { sqlite } from "../src/sqlite.js";
import { fixtureFetch } from "./helpers.js";

const BASE = "https://afriradar.test";
const T0 = new Date("2026-11-12T02:41:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

/** The fixture CSVs (week ended 2 Oct 2026) plus a weekly-email.json saying the site is at `site`. */
function siteAt(site: string | null, calls: string[] = [], edit?: (url: string, text: string) => string): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("/data/weekly-email.json")) {
      if (site === null) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ as_of: site, subject: "x" }), { headers: { "content-type": "application/json" } });
    }
    const res = await fixtureFetch(url, init);
    return edit && res.ok ? new Response(edit(String(url), await res.text())) : res;
  }) as typeof fetch;
}
const runs = (db: ReturnType<typeof sqlite>) => db.all<{ kind: string; changed: number; error: string | null }>("SELECT kind, changed, error FROM ingest_runs ORDER BY id");

describe("siteWeek", () => {
  it("reads the newest week from the site, and never throws", async () => {
    expect(await siteWeek(BASE, siteAt("2026-10-30"))).toBe("2026-10-30");
    expect(await siteWeek(BASE, siteAt(null))).toBeNull();
    expect(await siteWeek(BASE, siteAt("30 Oct"))).toBeNull();
    expect(await siteWeek(BASE, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe("writes only rows that are new or changed", () => {
  it("re-sending the same week or the whole history writes nothing", async () => {
    const db = sqlite();
    const first = await ingest(db, { baseUrl: BASE, history: true, fetchImpl: fixtureFetch });
    const rows = first.reduce((n, f) => n + f.rows, 0);
    expect(first.changed).toBe(rows); // an empty database: every row is new
    expect((await ingest(db, { baseUrl: BASE, history: true, fetchImpl: fixtureFetch })).changed).toBe(0);
    // The fixtures' latest-week file was captured at a different time from their history, so some rows truly
    // differ the first time; sending that same file again writes nothing.
    await ingest(db, { baseUrl: BASE, fetchImpl: fixtureFetch });
    expect((await ingest(db, { baseUrl: BASE, fetchImpl: fixtureFetch })).changed).toBe(0);
  });

  it("writes exactly the rows that differ", async () => {
    const db = sqlite();
    await ingest(db, { baseUrl: BASE, fetchImpl: fixtureFetch });
    // One money market fund's yield changes in the file: one row is written, nothing else.
    let done = false;
    const oneChange = siteAt("2026-10-02", [], (url, text) => {
      if (!url.endsWith("/money-market-funds.csv") || done) return text;
      const lines = text.split("\n");
      const cells = lines[1].split(",");
      cells[8] = String(Number(cells[8] || 0) + 0.01); // yield_wtd
      lines[1] = cells.join(",");
      done = true;
      return lines.join("\n");
    });
    expect((await ingest(db, { baseUrl: BASE, fetchImpl: oneChange })).changed).toBe(1);
  });

  it("the Kenya history is written once, then only when it changes", async () => {
    const db = sqlite();
    const a = await ingestKenya(db, { baseUrl: BASE, fetchImpl: fixtureFetch });
    expect(a.changed).toBe(a.rows);
    expect((await ingestKenya(db, { baseUrl: BASE, fetchImpl: fixtureFetch })).changed).toBe(0);
  });
});

describe("catchUp", () => {
  it("ingests when the API is empty or behind the site, and records the run", async () => {
    const db = sqlite();
    const r = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02"), now: T0 });
    expect(r).toMatchObject({ site: "2026-10-02", api: "2026-10-02", ingested: true });
    expect(r.changed).toBeGreaterThan(0);
    expect(await runs(db)).toEqual([{ kind: "catchup", changed: r.changed, error: null }]);
  });

  it("does nothing, not even a download, when the API already has the site's week", async () => {
    const db = sqlite();
    await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02"), now: T0 });
    const calls: string[] = [];
    const r = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02", calls), now: later(3_600_000) });
    expect(r).toEqual({ site: "2026-10-02", api: "2026-10-02", ingested: false, changed: 0 });
    expect(calls.filter((u) => u.endsWith(".csv"))).toEqual([]);
    expect(await runs(db)).toHaveLength(1);
  });

  it("runs at most one ingest in any 24 hours, even while the site stays ahead", async () => {
    const db = sqlite();
    await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02"), now: T0 });
    // The site says 9 Oct but its files still hold 2 Oct (a slow cache): one try, then no more that day.
    const calls: string[] = [];
    const tried = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-09"), now: later(CATCH_UP_GAP_MS) });
    expect(tried).toMatchObject({ ingested: true, api: "2026-10-02", changed: 0 });
    for (let h = 1; h < 24; h++) {
      const r = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-09", calls), now: later(CATCH_UP_GAP_MS + h * 3_600_000) });
      expect(r).toMatchObject({ ingested: false, skipped: "recent" });
    }
    expect(calls.filter((u) => u.endsWith(".csv"))).toEqual([]); // 23 hourly checks, not one download
    const next = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-09"), now: later(2 * CATCH_UP_GAP_MS) });
    expect(next.ingested).toBe(true);
    expect((await runs(db)).length).toBe(3);
  });

  it("a failed try counts as the day's try and is recorded", async () => {
    const db = sqlite();
    await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02"), now: T0 });
    const broken = (async (url: string) => (String(url).includes("weekly-email") ? new Response(JSON.stringify({ as_of: "2026-10-16" })) : new Response("gone", { status: 404 }))) as unknown as typeof fetch;
    await expect(catchUp(db, { baseUrl: BASE, fetchImpl: broken, now: later(CATCH_UP_GAP_MS) })).rejects.toThrow(/404/);
    expect((await catchUp(db, { baseUrl: BASE, fetchImpl: broken, now: later(CATCH_UP_GAP_MS + 3_600_000) })).skipped).toBe("recent");
    expect((await runs(db)).at(-1)).toMatchObject({ kind: "catchup", changed: 0 });
    expect((await runs(db)).at(-1)?.error).toMatch(/404/);
    expect(await latestWeek(db)).toBe("2026-10-02");
  });

  it("does nothing when the site cannot be read or is older", async () => {
    const db = sqlite();
    await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02"), now: T0 });
    expect((await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt(null), now: later(CATCH_UP_GAP_MS) })).ingested).toBe(false);
    expect((await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-09-25"), now: later(CATCH_UP_GAP_MS) })).ingested).toBe(false);
    expect(await latestWeek(db)).toBe("2026-10-02");
  });
});
