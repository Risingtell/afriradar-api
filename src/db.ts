// A small database seam: Cloudflare D1 in production, node:sqlite in tests and scripts. Same SQL on both.

export type Stmt = { sql: string; params?: unknown[] };

export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** Runs statements in one transaction: all apply or none do. */
  batch(stmts: Stmt[]): Promise<void>;
}

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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_created ON payments (created_at);
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
`;

type D1Like = {
  prepare(sql: string): { bind(...v: unknown[]): D1StmtLike } & D1StmtLike;
  batch(stmts: D1StmtLike[]): Promise<unknown>;
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
      if (stmts.length) await db.batch(stmts.map((s) => stmt(s.sql, s.params ?? [])));
    },
  };
}
