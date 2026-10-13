// Shared test setup: a sqlite database loaded with the captured real AfriRadar CSVs.
import { readFileSync, existsSync } from "node:fs";
import { ingest } from "../src/data/ingest.js";
import { CATEGORIES } from "../src/data/model.js";
import { sqlite } from "../src/sqlite.js";

export const HEADER = "week_ended,category,subgroup,fund,manager,manager_as_printed,nav_ngn,nav_usd,yield_wtd,yield_ytd,yield_wtd_as_printed,yield_ytd_as_printed,unitholders,bid_ngn,offer_ngn,bid_usd,offer_usd,flags,source_url";

export const fixtureFetch = (async (url: string) => {
  const file = String(url).split("/data/")[1];
  const path = `test/fixtures/${file}`;
  if (existsSync(path)) return new Response(readFileSync(path, "utf8"));
  const meta = Object.entries(CATEGORIES).find(([, m]) => file === `${m.file}.csv` || file === `${m.file}-history.csv`);
  if (!meta) return new Response("not found", { status: 404 });
  return new Response(`${HEADER}\n2026-10-02,${meta[0]},,Test ${meta[0]} Fund,Test Manager,Test Manager Ltd,1000,,0.01,0.1,0.01,0.1,10,1,1,,,,https://sec.gov.ng/x.xlsx\n`);
}) as typeof fetch;

export async function loadedDb() {
  const db = sqlite();
  await ingest(db, { baseUrl: "https://afriradar.test", history: true, fetchImpl: fixtureFetch });
  await ingest(db, { baseUrl: "https://afriradar.test", fetchImpl: fixtureFetch });
  return db;
}
