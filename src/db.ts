// A small database seam: Cloudflare D1 in production, node:sqlite in tests and scripts. Same SQL on both.

export type Stmt = { sql: string; params?: unknown[] };

export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** Runs statements in one transaction: all apply or none do. Returns the rows actually changed. */
  batch(stmts: Stmt[]): Promise<{ changes: number }>;
}

/**
 * The tail of an upsert that writes a row only when a value differs. Without it, re-sending identical rows
 * rewrites every one of them (and its index entries): three full-history reloads on 12 Nov 2026 wrote
 * 173,765 rows and used up D1's free 100,000 writes a day. IS NOT treats two NULLs as equal.
 */
export const changedOnly = (cols: readonly string[], table: string): string =>
  `DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")} WHERE ${cols.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(" OR ")}`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS fund_weeks (
  key TEXT NOT NULL,
  week TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT NOT NULL,
  subgroup TEXT,
  name TEXT NOT NULL,
  manager TEXT NOT NULL,
  nav_ngn REAL, nav_usd REAL,
  yield_wtd REAL, yield_ytd REAL,
  yield_wtd_printed REAL, yield_ytd_printed REAL,
  unitholders INTEGER,
  bid_ngn REAL, offer_ngn REAL, bid_usd REAL, offer_usd REAL,
  flags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  PRIMARY KEY (key, week)
);
CREATE INDEX IF NOT EXISTS fund_weeks_week ON fund_weeks (week, category);
CREATE INDEX IF NOT EXISTS fund_weeks_slug ON fund_weeks (slug, week);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  site_week TEXT,
  api_week TEXT,
  changed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ingest_runs_kind_at ON ingest_runs (kind, at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  tx TEXT,
  route TEXT NOT NULL,
  scheme TEXT NOT NULL,
  amount TEXT NOT NULL,
  ceiling TEXT,
  payer TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
);
CREATE INDEX IF NOT EXISTS payments_created ON payments (created_at);
CREATE INDEX IF NOT EXISTS payments_network_created ON payments (network, created_at);
CREATE INDEX IF NOT EXISTS payments_tx ON payments (tx);

CREATE TABLE IF NOT EXISTS channels (
  network TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  token_program TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  receiver_authorizer TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (network, channel_id)
);

CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, k)
);

CREATE TABLE IF NOT EXISTS kenya_quarters (
  key TEXT NOT NULL,
  quarter TEXT NOT NULL,
  name TEXT NOT NULL,
  aum_kes INTEGER NOT NULL,
  prev_aum_kes INTEGER,
  change REAL,
  share REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (key, quarter)
);
CREATE INDEX IF NOT EXISTS kenya_quarters_quarter ON kenya_quarters (quarter);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  tx TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS checks_at ON checks (at);
`;

type D1Like = {
  prepare(sql: string): { bind(...v: unknown[]): D1StmtLike } & D1StmtLike;
  batch(stmts: D1StmtLike[]): Promise<{ meta?: { changes?: number } }[]>;
};
type D1StmtLike = {
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
};

export function d1(db: D1Like): Db {
  const stmt = (sql: string, params: unknown[]) => (params.length ? db.prepare(sql).bind(...params) : db.prepare(sql));
  return {
    all: async <T>(sql: string, ...p: unknown[]) => (await stmt(sql, p).all<T>()).results,
    first: <T>(sql: string, ...p: unknown[]) => stmt(sql, p).first<T>(),
    run: async (sql, ...p) => ({ changes: (await stmt(sql, p).run()).meta.changes }),
    batch: async (stmts) => {
      if (!stmts.length) return { changes: 0 };
      const results = await db.batch(stmts.map((s) => stmt(s.sql, s.params ?? [])));
      return { changes: results.reduce((n, r) => n + (r?.meta?.changes ?? 0), 0) };
    },
  };
}
