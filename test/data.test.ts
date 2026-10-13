// Ingests real AfriRadar CSVs (captured 13 Oct 2026, SEC week ended 2 Oct 2026) and checks the paid queries.
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it, beforeAll } from "vitest";
import { parseCsv } from "../src/data/csv.js";
import { ingest, parseFile } from "../src/data/ingest.js";
import { CATEGORIES, slugify } from "../src/data/model.js";
import * as q from "../src/data/queries.js";
import { sqlite } from "../src/sqlite.js";

const HEADER = "week_ended,category,subgroup,fund,manager,manager_as_printed,nav_ngn,nav_usd,yield_wtd,yield_ytd,yield_wtd_as_printed,yield_ytd_as_printed,unitholders,bid_ngn,offer_ngn,bid_usd,offer_usd,flags,source_url";

// Serves the captured files; categories without a fixture get one synthetic fund so ingest has every category.
const fakeFetch = (async (url: string) => {
  const file = String(url).split("/data/")[1];
  const path = `test/fixtures/${file}`;
  if (existsSync(path)) return new Response(readFileSync(path, "utf8"));
  const meta = Object.entries(CATEGORIES).find(([, m]) => file.startsWith(m.file + "."))
    ?? Object.entries(CATEGORIES).find(([, m]) => file === `${m.file}-history.csv`);
  if (!meta) return new Response("not found", { status: 404 });
  return new Response(`${HEADER}\n2026-10-02,${meta[0]},,Test ${meta[0]} Fund,Test Manager,Test Manager Ltd,1000,,0.01,0.1,0.01,0.1,10,1,1,,,,https://sec.gov.ng/x.xlsx\n`);
}) as typeof fetch;

describe("csv", () => {
  it("parses quoted fields, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([{ a: "x, y", b: 'say "hi"' }]);
  });
  it("rejects a row with the wrong number of fields", () => {
    expect(() => parseCsv("a,b\n1,2,3\n")).toThrow(/3 fields/);
  });
});

describe("slugify matches AfriRadar's site slugs", () => {
  it.each([
    ["AIICO Money Market Fund", "aiico-money-market-fund"],
    ["Stanbic IBTC Shariah Fixed Income Fund", "stanbic-ibtc-shariah-fixed-income-fund"],
    ["FBN Halal & Ethical Fund", "fbn-halal-and-ethical-fund"],
  ])("%s", (name, slug) => expect(slugify(name)).toBe(slug));
});

describe("ingest", () => {
  it("rejects a file whose rows belong to another category", () => {
    const text = readFileSync("test/fixtures/money-market-funds.csv", "utf8");
    expect(() => parseFile(text, "bond")).toThrow(/money-market row/);
  });

  it("tells apart two funds SEC listed under one name in the same week, like AfriRadar does", () => {
    const rows = parseFile(`${HEADER}
2026-08-21,shariah,,Same Fund,A,A,1,,,,,,1,,,,,,s
2026-08-21,shariah,,Same Fund,B,B,2,,,,,,1,,,,,,s
2026-08-28,shariah,,Same Fund,B,B,2,,,,,,1,,,,,,s
`, "shariah");
    expect(rows.map((r) => `${r.week} ${r.key} ${r.manager}`)).toEqual([
      "2026-08-21 shariah/same-fund A",
      "2026-08-21 shariah/same-fund-2 B",
      "2026-08-28 shariah/same-fund B",
    ]);
  });

  it("rejects a malformed yield instead of storing it", () => {
    expect(() => parseFile(`${HEADER}\n2026-10-02,bond,,X Fund,M,M,1,,abc,0.1,,,1,,,,,,s\n`, "bond")).toThrow(/not a number/);
  });

  it("is idempotent: re-running the same week changes nothing", async () => {
    const db = sqlite();
    await ingest(db, { baseUrl: "https://afriradar.test", fetchImpl: fakeFetch });
    const before = await db.first<{ n: number }>("SELECT count(*) AS n FROM fund_weeks");
    await ingest(db, { baseUrl: "https://afriradar.test", fetchImpl: fakeFetch });
    const after = await db.first<{ n: number }>("SELECT count(*) AS n FROM fund_weeks");
    expect(after).toEqual(before);
  });
});

describe("queries on real SEC data", () => {
  const db = sqlite();
  beforeAll(async () => {
    await ingest(db, { baseUrl: "https://afriradar.test", history: true, fetchImpl: fakeFetch });
    await ingest(db, { baseUrl: "https://afriradar.test", fetchImpl: fakeFetch });
  });

  it("knows the latest SEC week", async () => {
    expect(await q.latestWeek(db)).toBe("2026-10-02");
  });

  it("top money market fund by year-to-date yield is First Ally at 21.29%", async () => {
    const t = await q.top(db, "money-market", "yield_ytd", 3);
    expect(t.funds[0].name).toBe("First Ally Money Market Fund");
    expect(t.funds[0].yieldYtd).toBeCloseTo(0.2129, 6);
  });

  it("returns 91 weeks of history for AIICO Money Market Fund", async () => {
    const h = await q.history(db, "money-market/aiico-money-market-fund");
    expect(h?.weeks).toHaveLength(91);
    expect(h?.weeks[0].week).toBe("2025-01-03");
    expect(h?.weeks.at(-1)?.navNgn).toBeCloseTo(46970484434.76, 2);
  });

  it("caps a fund lookup at 13 recent weeks", async () => {
    const f = await q.fund(db, "money-market/aiico-money-market-fund", 99);
    expect(f?.recent).toHaveLength(13);
  });

  it("free search finds funds by manager without revealing figures", async () => {
    const s = await q.search(db, "aiico");
    expect(s.map((x) => x.id)).toContain("money-market/aiico-money-market-fund");
    expect(Object.keys(s[0])).toEqual(["id", "name", "manager", "category"]);
  });

  it("compare reports unknown ids instead of failing", async () => {
    const c = await q.compare(db, ["money-market/aiico-money-market-fund", "money-market/no-such-fund"]);
    expect(c.funds.map((f) => f.found)).toEqual([true, false]);
  });

  it("overview counts all 49 money market funds", async () => {
    const o = await q.overview(db);
    expect(o.categories.find((c) => c.id === "money-market")?.funds).toBe(49);
  });
});
