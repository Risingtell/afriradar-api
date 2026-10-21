// The hourly end-to-end check. The demo wallet buys one data product through the normal x402 flow
// and, every sixth hour, asks the analyst one question. Each result goes into the checks table and
// /v1/status. The payments are real devnet settlements, so they stay in the public ledger, labelled
// monitor, and are left out of the visitor figures.
import type { Hono } from "hono";
import type { TransactionSigner } from "@solana/kit";
import { decodePaymentResponseHeader } from "@x402/fetch";
import type { Db } from "./db.js";
import { localPaidFetch } from "./demo.js";

export const MONITOR = {
  everyMinutes: 60,
  data: "/v1/funds/money-market/stanbic-ibtc-money-market-fund",
  ask: { question: "Which naira money market fund has the highest year-to-date yield?", everyHours: 6 },
};

export type CheckKind = "data" | "ask";
export type Check = { kind: CheckKind; ok: boolean; status: number; ms: number; tx: string | null; detail: string | null };

/** Which checks the hourly run makes at this time. */
export const kindsAt = (now: Date): CheckKind[] => (now.getUTCHours() % MONITOR.ask.everyHours === 0 ? ["data", "ask"] : ["data"]);

export async function runMonitor(opts: { app: Hono; db: Db; signer: TransactionSigner; rpcUrl: string; now: () => Date; kinds: CheckKind[] }): Promise<Check[]> {
  const paid = localPaidFetch(opts.app, opts.signer, opts.rpcUrl);
  const out: Check[] = [];
  for (const kind of opts.kinds) {
    const started = opts.now();
    const t0 = Date.now();
    let check: Check;
    try {
      const path = kind === "data" ? MONITOR.data : "/v1/ask";
      const res = await paid(
        `https://api.afriradar.com${path}`,
        kind === "ask" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: MONITOR.ask.question }) } : undefined,
      );
      const header = res.headers.get("PAYMENT-RESPONSE");
      const receipt = header ? (decodePaymentResponseHeader(header) as { success?: boolean; transaction?: string; errorReason?: string }) : null;
      const data = (await res.json().catch(() => null)) as { id?: string; recent?: unknown[]; answer?: unknown; bill?: { total?: number }; error?: string } | null;
      const delivered = kind === "data" ? MONITOR.data.endsWith(data?.id ?? "-") && Array.isArray(data?.recent) : typeof data?.answer === "string" && data.answer.length > 20 && (data.bill?.total ?? 0) > 0;
      const ok = res.ok && receipt?.success === true && delivered;
      check = { kind, ok, status: res.status, ms: Date.now() - t0, tx: receipt?.transaction || null, detail: ok ? null : data?.error ?? receipt?.errorReason ?? `HTTP ${res.status}` };
      await label(opts.db, { path, payer: opts.signer.address, since: started.toISOString(), tx: check.tx });
    } catch (e) {
      check = { kind, ok: false, status: 0, ms: Date.now() - t0, tx: null, detail: (e as Error).message };
    }
    await opts.db.run(
      "INSERT INTO checks (id, at, kind, ok, status, ms, tx, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), started.toISOString(), check.kind, check.ok ? 1 : 0, check.status, check.ms, check.tx, check.detail,
    );
    out.push(check);
  }
  return out;
}

/** Marks the monitor's own ledger rows: the settlement by its transaction, a question's deposit by payer, route and time. */
async function label(db: Db, m: { path: string; payer: string; since: string; tx: string | null }) {
  if (m.tx) await db.run("UPDATE payments SET detail = 'monitor' WHERE tx = ? AND status = 'settled'", m.tx);
  if (m.path === "/v1/ask") {
    await db.run("UPDATE payments SET detail = 'monitor' WHERE route = ? AND payer = ? AND status = 'deposit' AND created_at >= ? AND detail IS NULL", m.path, m.payer, m.since);
  }
}

type Row = { at: string; kind: CheckKind; ok: number; status: number; ms: number; tx: string | null; detail: string | null };
const tally = (rows: Row[]) => ({ runs: rows.length, passed: rows.filter((r) => r.ok).length });

export async function monitorStatus(db: Db, now: Date, explorer: (sig: string) => string) {
  const since = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const week = await db.all<Row>("SELECT at, kind, ok, status, ms, tx, detail FROM checks WHERE at >= ? ORDER BY at DESC", since(24 * 7));
  const shape = (r: Row) => ({ at: r.at, kind: r.kind, ok: !!r.ok, status: r.status, ms: r.ms, tx: r.tx, explorer: r.tx ? explorer(r.tx) : null, detail: r.detail });
  return {
    monitor: `Every ${MONITOR.everyMinutes} minutes the demo wallet pays for ${MONITOR.data} through the normal x402 flow; every ${MONITOR.ask.everyHours} hours it also asks the analyst a question. A check passes only if the payment settled on Solana and the data or answer came back.`,
    last: week[0] ? shape(week[0]) : null,
    last24h: tally(week.filter((r) => r.at >= since(24))),
    last7d: { ...tally(week), data: tally(week.filter((r) => r.kind === "data")), ask: tally(week.filter((r) => r.kind === "ask")) },
    recent: week.slice(0, 24).map(shape),
  };
}
