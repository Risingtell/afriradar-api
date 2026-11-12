-- One row per ingest run (src/data/freshness.ts, src/worker.ts): what ran, the weeks before and after, and how many
-- rows it actually wrote. The hourly catch-up reads it so it never runs a full ingest more than once a day.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,            -- catchup | daily
  site_week TEXT,
  api_week TEXT,
  changed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ingest_runs_kind_at ON ingest_runs (kind, at);
