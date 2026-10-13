// AfriRadar's fund categories and the row shape of its public CSVs (afriradar.com/data/<file>.csv).

export const CATEGORIES = {
  "money-market": { name: "Money market funds", file: "money-market-funds" },
  bond: { name: "Bond and fixed income funds", file: "bond-funds" },
  dollar: { name: "Dollar funds", file: "dollar-funds" },
  equity: { name: "Equity funds", file: "equity-funds" },
  balanced: { name: "Balanced funds", file: "balanced-funds" },
  shariah: { name: "Shariah-compliant funds", file: "shariah-funds" },
  reit: { name: "Real estate investment trusts", file: "reits" },
  ethical: { name: "Ethical funds", file: "ethical-funds" },
  specialised: { name: "Specialised funds", file: "specialised-funds" },
} as const;

export type Category = keyof typeof CATEGORIES;
export const isCategory = (v: unknown): v is Category => typeof v === "string" && v in CATEGORIES;

/** One fund in one SEC weekly report, as stored and as returned by the API. */
export type FundWeek = {
  key: string; // category/slug, stable across weeks
  slug: string;
  category: Category;
  subgroup: string | null;
  name: string;
  manager: string;
  week: string; // YYYY-MM-DD, the report's "week ended" date
  navNgn: number | null;
  navUsd: number | null;
  yieldWtd: number | null; // decimal, 0.1634 = 16.34%
  yieldYtd: number | null;
  yieldWtdPrinted: number | null; // the figure exactly as SEC printed it
  yieldYtdPrinted: number | null;
  unitholders: number | null;
  bidNgn: number | null;
  offerNgn: number | null;
  bidUsd: number | null;
  offerUsd: number | null;
  flags: string[];
  source: string; // SEC .xlsx the row was read from
};

// Same rule as AfriRadar's pipeline (sec_nav.slugify), so slugs match afriradar.com/funds/<slug>.
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "fund";
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
};

/** Converts one AfriRadar CSV row. Throws on anything malformed so a bad file is rejected whole. */
export function fromCsvRow(r: Record<string, string>): FundWeek {
  const category = r.category;
  if (!isCategory(category)) throw new Error(`unknown category: ${category}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.week_ended ?? "")) throw new Error(`bad week_ended: ${r.week_ended}`);
  if (!r.fund) throw new Error("row without a fund name");
  const slug = slugify(r.fund);
  const units = num(r.unitholders);
  return {
    key: `${category}/${slug}`,
    slug,
    category,
    subgroup: r.subgroup || null,
    name: r.fund,
    manager: r.manager || r.manager_as_printed || "",
    week: r.week_ended,
    navNgn: num(r.nav_ngn),
    navUsd: num(r.nav_usd),
    yieldWtd: num(r.yield_wtd),
    yieldYtd: num(r.yield_ytd),
    yieldWtdPrinted: num(r.yield_wtd_as_printed),
    yieldYtdPrinted: num(r.yield_ytd_as_printed),
    unitholders: units === null ? null : Math.round(units),
    bidNgn: num(r.bid_ngn),
    offerNgn: num(r.offer_ngn),
    bidUsd: num(r.bid_usd),
    offerUsd: num(r.offer_usd),
    flags: (r.flags ?? "").split(/\s+/).filter(Boolean),
    source: r.source_url ?? "",
  };
}
