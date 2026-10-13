// Read side of the fund data. Every function returns plain JSON that the API sells as-is.
import type { Db } from "../db.js";
import { CATEGORIES, type Category } from "./model.js";

type Row = {
  key: string; week: string; slug: string; category: Category; subgroup: string | null; name: string; manager: string;
  nav_ngn: number | null; nav_usd: number | null; yield_wtd: number | null; yield_ytd: number | null;
  yield_wtd_printed: number | null; yield_ytd_printed: number | null; unitholders: number | null;
  bid_ngn: number | null; offer_ngn: number | null; bid_usd: number | null; offer_usd: number | null;
  flags: string; source: string;
};

export type Fund = ReturnType<typeof toFund>;

const toFund = (r: Row) => ({
  id: r.key,
  name: r.name,
  manager: r.manager,
  category: r.category,
  subgroup: r.subgroup,
  week: r.week,
  navNgn: r.nav_ngn,
  navUsd: r.nav_usd,
  yieldWtd: r.yield_wtd,
  yieldYtd: r.yield_ytd,
  unitholders: r.unitholders,
  bidNgn: r.bid_ngn,
  offerNgn: r.offer_ngn,
  bidUsd: r.bid_usd,
  offerUsd: r.offer_usd,
  flags: r.flags ? r.flags.split(" ") : [],
  source: r.source,
});

export async function latestWeek(db: Db): Promise<string | null> {
  return (await db.first<{ w: string | null }>("SELECT max(week) AS w FROM fund_weeks"))?.w ?? null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Free overview: what exists, how big it is, how fresh it is. */
export async function overview(db: Db) {
  const week = await latestWeek(db);
  const rows = week ? await db.all<Row>("SELECT * FROM fund_weeks WHERE week = ?", week) : [];
  const weeks = (await db.first<{ n: number; first: string }>("SELECT count(DISTINCT week) AS n, min(week) AS first FROM fund_weeks")) ?? { n: 0, first: null };
  return {
    week,
    weeksOnFile: weeks.n,
    firstWeek: weeks.first,
    funds: rows.length,
    categories: (Object.keys(CATEGORIES) as Category[]).map((c) => {
      const in_ = rows.filter((r) => r.category === c);
      return {
        id: c,
        name: CATEGORIES[c].name,
        funds: in_.length,
        navNgn: in_.reduce((a, r) => a + (r.nav_ngn ?? 0), 0),
        unitholders: in_.reduce((a, r) => a + (r.unitholders ?? 0), 0),
        medianYieldYtd: median(in_.map((r) => r.yield_ytd).filter((y): y is number => y !== null)),
      };
    }),
  };
}

/** Free name search so buyers can find fund ids before paying. Names and ids only. */
export async function search(db: Db, q: string, limit = 10) {
  const week = await latestWeek(db);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!week || !terms.length) return [];
  const where = terms.map(() => "(lower(name) LIKE ? OR lower(manager) LIKE ?)").join(" AND ");
  const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  const rows = await db.all<Row>(`SELECT key, name, manager, category FROM fund_weeks WHERE week = ? AND ${where} ORDER BY nav_ngn DESC LIMIT ?`, week, ...params, Math.min(limit, 25));
  return rows.map((r) => ({ id: r.key, name: r.name, manager: r.manager, category: r.category }));
}

export async function category(db: Db, c: Category) {
  const week = await latestWeek(db);
  const rows = await db.all<Row>("SELECT * FROM fund_weeks WHERE week = ? AND category = ? ORDER BY nav_ngn DESC", week, c);
  return { week, category: c, name: CATEGORIES[c].name, funds: rows.map(toFund) };
}

export async function fund(db: Db, id: string, weeks = 13) {
  const rows = await db.all<Row>("SELECT * FROM fund_weeks WHERE key = ? ORDER BY week DESC LIMIT ?", id, Math.min(Math.max(weeks, 1), 13));
  if (!rows.length) return null;
  const [latest] = rows;
  return { ...toFund(latest), recent: rows.map((r) => ({ week: r.week, navNgn: r.nav_ngn, navUsd: r.nav_usd, yieldWtd: r.yield_wtd, yieldYtd: r.yield_ytd, unitholders: r.unitholders })) };
}

export async function history(db: Db, id: string) {
  const rows = await db.all<Row>("SELECT * FROM fund_weeks WHERE key = ? ORDER BY week ASC", id);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {
    id,
    name: last.name,
    manager: last.manager,
    category: last.category,
    weeks: rows.map((r) => ({ week: r.week, navNgn: r.nav_ngn, navUsd: r.nav_usd, yieldWtd: r.yield_wtd, yieldYtd: r.yield_ytd, unitholders: r.unitholders, bidNgn: r.bid_ngn, offerNgn: r.offer_ngn, flags: r.flags ? r.flags.split(" ") : [], source: r.source })),
  };
}

export const RANK_BY = { yield_ytd: "yield_ytd", yield_wtd: "yield_wtd", nav: "nav_ngn", unitholders: "unitholders" } as const;
export type RankBy = keyof typeof RANK_BY;

export async function top(db: Db, c: Category, by: RankBy, limit = 10) {
  const week = await latestWeek(db);
  const col = RANK_BY[by];
  const rows = await db.all<Row>(`SELECT * FROM fund_weeks WHERE week = ? AND category = ? AND ${col} IS NOT NULL ORDER BY ${col} DESC LIMIT ?`, week, c, Math.min(Math.max(limit, 1), 50));
  return { week, category: c, by, funds: rows.map(toFund) };
}

/** Side by side: latest figures plus yield change against 4 and 13 weeks earlier. */
export async function compare(db: Db, ids: string[]) {
  const out = [];
  for (const id of ids.slice(0, 5)) {
    const rows = await db.all<Row>("SELECT * FROM fund_weeks WHERE key = ? ORDER BY week DESC LIMIT 14", id);
    if (!rows.length) {
      out.push({ id, found: false as const });
      continue;
    }
    const ago = (n: number) => rows[n]?.yield_ytd ?? null;
    const now = rows[0].yield_ytd;
    out.push({
      found: true as const,
      ...toFund(rows[0]),
      yieldYtd4WeeksAgo: ago(4),
      yieldYtd13WeeksAgo: ago(13),
      navChange13Weeks: rows[0].nav_ngn !== null && rows[13]?.nav_ngn ? rows[0].nav_ngn / rows[13].nav_ngn - 1 : null,
      yieldYtdChange4Weeks: now !== null && ago(4) !== null ? now - (ago(4) as number) : null,
    });
  }
  return { funds: out };
}
