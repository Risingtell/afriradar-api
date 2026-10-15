// Writes the full AfriRadar history as a SQL file for `wrangler d1 execute --file`.
// Usage: npx tsx scripts/backfill.ts [baseUrl] > backfill.sql
import { CATEGORIES, type Category } from "../src/data/model.js";
import { parseFile, upsertStatements } from "../src/data/ingest.js";

const base = (process.argv[2] ?? "https://afriradar.com").replace(/\/$/, "");
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
let rows = 0;
for (const [category, meta] of Object.entries(CATEGORIES) as [Category, (typeof CATEGORIES)[Category]][]) {
  for (const suffix of ["-history", ""]) {
    const res = await fetch(`${base}/data/${meta.file}${suffix}.csv`);
    if (!res.ok) throw new Error(`${meta.file}${suffix}.csv returned ${res.status}`);
    const parsed = parseFile(await res.text(), category);
    rows += parsed.length;
    for (const s of upsertStatements(parsed, 150)) process.stdout.write(s.sql.replace("?1", lit(String(s.params?.[0]))) + ";\n");
  }
}
console.error(`${rows} rows written`);
