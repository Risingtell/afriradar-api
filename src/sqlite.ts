// node:sqlite implementation of the Db seam, for tests and local scripts (Node 22.5+).
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, type Db } from "./db.js";

type SqlValue = null | number | bigint | string | Uint8Array;
const bind = (p: unknown[]) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)) as SqlValue[];

export function sqlite(path = ":memory:"): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA);
  return {
    raw,
    all: async <T>(sql: string, ...p: unknown[]) => raw.prepare(sql).all(...bind(p)) as T[],
    first: async <T>(sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...bind(p)) as T | undefined) ?? null,
    run: async (sql, ...p) => ({ changes: Number(raw.prepare(sql).run(...bind(p)).changes) }),
    batch: async (stmts) => {
      raw.exec("BEGIN");
      try {
        for (const s of stmts) raw.prepare(s.sql).run(...bind(s.params ?? []));
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
