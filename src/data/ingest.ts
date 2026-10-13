// Pulls AfriRadar's public weekly CSVs and stores them. A file that fails to parse is rejected whole.
import type { Db, Stmt } from "../db.js";
import { parseCsv } from "./csv.js";
import { CATEGORIES, fromCsvRow, type Category, type FundWeek } from "./model.js";

const COLS = [
  "key", "week", "slug", "category", "subgroup", "name", "manager", "nav_ngn", "nav_usd", "yield_wtd", "yield_ytd",
  "yield_wtd_printed", "yield_ytd_printed", "unitholders", "bid_ngn", "offer_ngn", "bid_usd", "offer_usd", "flags", "source",
] as const;

const toRecord = (f: FundWeek) => ({
  key: f.key, week: f.week, slug: f.slug, category: f.category, subgroup: f.subgroup, name: f.name, manager: f.manager,
  nav_ngn: f.navNgn, nav_usd: f.navUsd, yield_wtd: f.yieldWtd, yield_ytd: f.yieldYtd,
  yield_wtd_printed: f.yieldWtdPrinted, yield_ytd_printed: f.yieldYtdPrinted, unitholders: f.unitholders,
  bid_ngn: f.bidNgn, offer_ngn: f.offerNgn, bid_usd: f.bidUsd, offer_usd: f.offerUsd, flags: f.flags.join(" "), source: f.source,
});

// One bound parameter carries a JSON array of rows, so a whole week is one statement (D1 caps bound params at 100).
const UPSERT = `INSERT INTO fund_weeks (${COLS.join(", ")})
SELECT ${COLS.map((c) => `json_extract(value, '$.${c}')`).join(", ")} FROM json_each(?1) WHERE true
ON CONFLICT (key, week) DO UPDATE SET ${COLS.filter((c) => c !== "key" && c !== "week").map((c) => `${c} = excluded.${c}`).join(", ")}`;

/** Upsert statements for a set of rows, chunked so no single statement grows past D1's size limit. */
export function upsertStatements(rows: FundWeek[], chunk = 300): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += chunk) {
    out.push({ sql: UPSERT, params: [JSON.stringify(rows.slice(i, i + chunk).map(toRecord))] });
  }
  return out;
}

export function parseFile(text: string, expected: Category): FundWeek[] {
  const rows = parseCsv(text).map(fromCsvRow);
  const wrong = rows.find((r) => r.category !== expected);
  if (wrong) throw new Error(`${expected} file holds a ${wrong.category} row (${wrong.name})`);
  const keys = new Set<string>();
  for (const r of rows) {
    const id = `${r.key}@${r.week}`;
    if (keys.has(id)) throw new Error(`duplicate fund in one week: ${id}`);
    keys.add(id);
  }
  return rows;
}

export type IngestResult = { category: Category; rows: number; weeks: string[] }[];

/** Fetches each category's CSV (latest week, or full history) and stores every row in one transaction. */
export async function ingest(
  db: Db,
  opts: { baseUrl: string; history?: boolean; fetchImpl?: typeof fetch },
): Promise<IngestResult> {
  const get = opts.fetchImpl ?? fetch;
  const result: IngestResult = [];
  const stmts: Stmt[] = [];
  for (const [category, meta] of Object.entries(CATEGORIES) as [Category, (typeof CATEGORIES)[Category]][]) {
    const url = `${opts.baseUrl.replace(/\/$/, "")}/data/${meta.file}${opts.history ? "-history" : ""}.csv`;
    const res = await get(url);
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const rows = parseFile(await res.text(), category);
    if (!rows.length) throw new Error(`${url} has no rows`);
    stmts.push(...upsertStatements(rows));
    result.push({ category, rows: rows.length, weeks: [...new Set(rows.map((r) => r.week))].sort() });
  }
  await db.batch(stmts);
  return result;
}
