-- The hourly end-to-end payment monitor's results (src/monitor.ts, served at /v1/status).
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
