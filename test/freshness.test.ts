// The hourly catch-up: ingest only when the website has a newer SEC week than the API holds.
import { describe, expect, it } from "vitest";
import { catchUp, siteWeek } from "../src/data/freshness.js";
import { latestWeek } from "../src/data/queries.js";
import { sqlite } from "../src/sqlite.js";
import { fixtureFetch } from "./helpers.js";

const BASE = "https://afriradar.test";

/** The fixture CSVs (week ended 2 Oct 2026) plus a weekly-email.json saying the site is at `site`. */
function siteAt(site: string | null, calls: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("/data/weekly-email.json")) {
      if (site === null) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ as_of: site, subject: "x" }), { headers: { "content-type": "application/json" } });
    }
    return fixtureFetch(url, init);
  }) as typeof fetch;
}

describe("siteWeek", () => {
  it("reads the newest week from the site, and never throws", async () => {
    expect(await siteWeek(BASE, siteAt("2026-10-30"))).toBe("2026-10-30");
    expect(await siteWeek(BASE, siteAt(null))).toBeNull();
    expect(await siteWeek(BASE, siteAt("30 Oct"))).toBeNull();
    expect(await siteWeek(BASE, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe("catchUp", () => {
  it("ingests when the API is empty or behind the site", async () => {
    const db = sqlite();
    const r = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02") });
    expect(r).toEqual({ site: "2026-10-02", api: "2026-10-02", ingested: true });
    expect(await latestWeek(db)).toBe("2026-10-02");
  });

  it("does nothing when the API already has the site's week", async () => {
    const db = sqlite();
    await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02") });
    const calls: string[] = [];
    const r = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02", calls) });
    expect(r).toEqual({ site: "2026-10-02", api: "2026-10-02", ingested: false });
    expect(calls.filter((u) => u.endsWith(".csv"))).toEqual([]); // one small read, no CSV downloads
  });

  it("does nothing when the site cannot be read or is older", async () => {
    const db = sqlite();
    await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02") });
    expect((await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt(null) })).ingested).toBe(false);
    expect((await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-09-25") })).ingested).toBe(false);
    expect(await latestWeek(db)).toBe("2026-10-02");
  });

  it("tries the ingest when the site is ahead, and lets a failure surface", async () => {
    const db = sqlite();
    await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-02") });
    // The site says 9 Oct but its CSVs still hold 2 Oct (a slow cache): the API stays at 2 Oct and the next hour retries.
    const r = await catchUp(db, { baseUrl: BASE, fetchImpl: siteAt("2026-10-09") });
    expect(r).toEqual({ site: "2026-10-09", api: "2026-10-02", ingested: true });
    const broken = (async (url: string) => (String(url).includes("weekly-email") ? new Response(JSON.stringify({ as_of: "2026-10-16" })) : new Response("gone", { status: 404 }))) as unknown as typeof fetch;
    await expect(catchUp(db, { baseUrl: BASE, fetchImpl: broken })).rejects.toThrow(/404/);
    expect(await latestWeek(db)).toBe("2026-10-02");
  });
});
