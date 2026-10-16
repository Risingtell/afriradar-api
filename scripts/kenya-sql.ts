// Prints SQL that loads AfriRadar's Kenya history into D1, for `wrangler d1 execute --file`.
// The daily cron does the same through ingestKenya; this is for loading it right after a deploy.
//   npx tsx scripts/kenya-sql.ts [baseUrl] > .wrangler-kenya.sql
import { parseKenya, KENYA_FILE } from "../src/data/kenya.js";

const base = (process.argv[2] ?? "https://afriradar.com").replace(/\/$/, "");
const res = await fetch(`${base}/data/${KENYA_FILE}.csv`);
if (!res.ok) throw new Error(`${base} returned ${res.status}`);
const rows = parseKenya(await res.text());
const lit = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
for (const r of rows) {
  console.log(
    `INSERT INTO kenya_quarters (key, quarter, name, aum_kes, prev_aum_kes, change, share, source) VALUES (${[r.key, r.quarter, r.name, r.aum_kes, r.prev_aum_kes, r.change, r.share, r.source].map(lit).join(", ")})` +
      " ON CONFLICT (key, quarter) DO UPDATE SET name = excluded.name, aum_kes = excluded.aum_kes, prev_aum_kes = excluded.prev_aum_kes, change = excluded.change, share = excluded.share, source = excluded.source;",
  );
}
console.error(`${rows.length} rows, ${new Set(rows.map((r) => r.quarter)).size} quarters`);
