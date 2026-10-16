// Kenya: unit trust schemes from the Capital Markets Authority of Kenya's quarterly statistical
// bulletin, as AfriRadar publishes them (afriradar.com/data/kenya-unit-trusts-history.csv).
// Quarterly and per scheme (a manager's umbrella of funds): CMA publishes no prices or yields.
import type { Db, Stmt } from "../db.js";
import { parseCsv } from "./csv.js";

export const KENYA_FILE = "kenya-unit-trusts-history";
export const KENYA_SOURCE = "Capital Markets Authority of Kenya, quarterly statistical bulletin, via afriradar.com";

export type KenyaRow = {
  key: string;
  quarter: string;
  name: string;
  aum_kes: number;
  prev_aum_kes: number | null;
  change: number | null;
  share: number;
  source: string;
};

const num = (v: string | undefined, field: string): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} is not a number: ${v}`);
  return n;
};

/** Converts AfriRadar's Kenya CSV. Throws on anything malformed so a bad file is rejected whole. */
export function parseKenya(text: string): KenyaRow[] {
  const rows = parseCsv(text).map((r) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.quarter_ended ?? "")) throw new Error(`bad quarter_ended: ${r.quarter_ended}`);
    if (!r.scheme || !/^[a-z0-9-]+$/.test(r.scheme_key ?? "")) throw new Error(`bad scheme row: ${r.scheme} / ${r.scheme_key}`);
    const aum = num(r.aum_kes, "aum_kes");
    const share = num(r.market_share, "market_share");
    if (aum === null || share === null) throw new Error(`${r.scheme} has no AUM or share`);
    return {
      key: r.scheme_key,
      quarter: r.quarter_ended,
      name: r.scheme,
      aum_kes: Math.round(aum),
      prev_aum_kes: num(r.previous_quarter_aum_kes, "previous_quarter_aum_kes"),
      change: num(r.change, "change"),
      share,
      source: r.source_url ?? "",
    };
  });
  const seen = new Set<string>();
  for (const r of rows) {
    const id = `${r.key}@${r.quarter}`;
    if (seen.has(id)) throw new Error(`scheme ${r.key} appears twice in ${r.quarter}`);
    seen.add(id);
  }
  return rows;
}

const COLS = ["key", "quarter", "name", "aum_kes", "prev_aum_kes", "change", "share", "source"] as const;
const UPSERT = `INSERT INTO kenya_quarters (${COLS.join(", ")})
SELECT ${COLS.map((c) => `json_extract(value, '$.${c}')`).join(", ")} FROM json_each(?1) WHERE true
ON CONFLICT (key, quarter) DO UPDATE SET ${COLS.filter((c) => c !== "key" && c !== "quarter").map((c) => `${c} = excluded.${c}`).join(", ")}`;

export function kenyaStatements(rows: KenyaRow[], chunk = 300): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < rows.length; i += chunk) out.push({ sql: UPSERT, params: [JSON.stringify(rows.slice(i, i + chunk))] });
  return out;
}

/** Fetches the full Kenya history (a few hundred rows) and upserts it in one transaction. */
export async function ingestKenya(db: Db, opts: { baseUrl: string; fetchImpl?: typeof fetch }) {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/data/${KENYA_FILE}.csv`;
  const res = await (opts.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const rows = parseKenya(await res.text());
  if (!rows.length) throw new Error(`${url} has no rows`);
  await db.batch(kenyaStatements(rows));
  return { rows: rows.length, quarters: [...new Set(rows.map((r) => r.quarter))].sort() };
}

// ---------- queries ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "quarter ended 31 March 2026": the plain name for a quarter, never "Q2" (CMA's bulletins are named by publication quarter). */
export const quarterLabel = (iso: string | null) =>
  iso ? `quarter ended ${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : null;

const scheme = (r: KenyaRow) => ({
  id: r.key,
  name: r.name,
  quarter: r.quarter,
  aumKes: r.aum_kes,
  prevQuarterAumKes: r.prev_aum_kes,
  changeOnQuarter: r.change,
  marketShare: r.share,
});

export async function latestQuarter(db: Db): Promise<string | null> {
  return (await db.first<{ q: string | null }>("SELECT max(quarter) AS q FROM kenya_quarters"))?.q ?? null;
}

/** Free: how big and how fresh the Kenya data is. */
export async function kenyaOverview(db: Db) {
  const quarter = await latestQuarter(db);
  if (!quarter) return null;
  const t = await db.first<{ n: number; aum: number }>("SELECT count(*) AS n, sum(aum_kes) AS aum FROM kenya_quarters WHERE quarter = ?", quarter);
  const span = await db.first<{ n: number; first: string }>("SELECT count(DISTINCT quarter) AS n, min(quarter) AS first FROM kenya_quarters");
  return { market: "kenya", quarter, quarterLabel: quarterLabel(quarter), schemes: t?.n ?? 0, aumKes: t?.aum ?? 0, quartersOnFile: span?.n ?? 0, firstQuarter: span?.first ?? null, source: KENYA_SOURCE };
}

/** Free name search for scheme ids. Names and ids only. */
export async function searchKenya(db: Db, q: string, limit = 10) {
  const quarter = await latestQuarter(db);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!quarter || !terms.length) return [];
  const where = terms.map(() => "(lower(name) LIKE ? OR key LIKE ?)").join(" AND ");
  const rows = await db.all<KenyaRow>(`SELECT key, name FROM kenya_quarters WHERE quarter = ? AND ${where} ORDER BY aum_kes DESC LIMIT ?`, quarter, ...terms.flatMap((t) => [`%${t}%`, `%${t}%`]), Math.min(limit, 25));
  return rows.map((r) => ({ id: r.key, name: r.name, market: "kenya" as const }));
}

/** Paid: every scheme for the latest quarter, largest first, with the quarter's total. */
export async function kenyaSchemes(db: Db) {
  const quarter = await latestQuarter(db);
  const rows = quarter ? await db.all<KenyaRow>("SELECT * FROM kenya_quarters WHERE quarter = ? ORDER BY aum_kes DESC", quarter) : [];
  const total = rows.reduce((a, r) => a + r.aum_kes, 0);
  const before = rows.reduce((a, r) => a + (r.prev_aum_kes ?? 0), 0);
  return {
    market: "kenya",
    quarter,
    quarterLabel: quarterLabel(quarter),
    currency: "KES",
    schemes: rows.length,
    totalAumKes: total,
    changeOnQuarter: before ? total / before - 1 : null,
    note: "Per scheme (a fund manager's umbrella of unit trust funds), quarterly. CMA publishes no prices or yields. totalAumKes is the sum of the schemes' figures; CMA's printed total can differ from it by rounding.",
    source: rows[0]?.source ?? null,
    rows: rows.map(scheme),
  };
}

/** Paid: one scheme's quarterly history. */
export async function kenyaScheme(db: Db, id: string) {
  const rows = await db.all<KenyaRow>("SELECT * FROM kenya_quarters WHERE key = ? ORDER BY quarter ASC", id);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {
    market: "kenya",
    id,
    name: last.name,
    currency: "KES",
    quarters: rows.map((r) => ({ ...scheme(r), source: r.source })),
  };
}
