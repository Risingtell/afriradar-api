-- Kenya: unit trust schemes from CMA Kenya's quarterly statistical bulletin (afriradar.com/data/kenya-unit-trusts*.csv).
CREATE TABLE IF NOT EXISTS kenya_quarters (
  key TEXT NOT NULL, -- scheme key, stable across renames (AfriRadar's kenya_cma.scheme_key)
  quarter TEXT NOT NULL, -- YYYY-MM-DD, quarter end
  name TEXT NOT NULL, -- scheme name as CMA printed it that quarter
  aum_kes INTEGER NOT NULL,
  prev_aum_kes INTEGER, -- CMA's figure for the quarter before, as printed in the same bulletin
  change REAL, -- worked out from the two figures; null for a new scheme
  share REAL NOT NULL,
  source TEXT NOT NULL, -- the CMA bulletin PDF
  PRIMARY KEY (key, quarter)
);
CREATE INDEX IF NOT EXISTS kenya_quarters_quarter ON kenya_quarters (quarter);
