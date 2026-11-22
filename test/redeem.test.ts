// /v1/redeem/:tx releases the data of a payment that was unconfirmed when it was made, once the chain
// shows it. Only a payment whose data was never served: every transaction id is public in
// /v1/payments, and nearly every one there was served when it was paid. Not once only: a first redeem
// by someone else must not use up the buyer's.
import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network, SupportedResponse } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { InMemoryPaymentChannelStorage, UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { createApp, REDEEMS_PER_HOUR } from "../src/app.js";
import { MAINNET, NETWORK, PRODUCTS } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import type { ChainPayment } from "../src/reconcile.js";
import { sweepCounters } from "../src/limits.js";
import { sqlite } from "../src/sqlite.js";
import { loadedDb } from "./helpers.js";

const RPC = "http://127.0.0.1:9"; // nothing listens
let db: Db;
let chain: ChainPayment = { status: "confirmed", received: 3_600n, slot: 1 };
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  db = await loadedDb();
  const svm = toFacilitatorSvmSigner(await generateKeyPairSigner(), { defaultRpcUrl: RPC });
  const networks = [NETWORK, MAINNET] as Network[];
  const real = new x402Facilitator()
    .register(networks, new ExactFacilitator(svm))
    .register(networks, new UptoFacilitator(svm, { channelStorage: new InMemoryPaymentChannelStorage() }));
  app = await createApp({
    db,
    facilitator: {
      verify: async () => ({ isValid: false, invalidReason: "not used here", payer: "" }),
      settle: async (_p, r) => ({ success: false, errorReason: "not used here", transaction: "", network: r.network }),
      getSupported: async () => real.getSupported() as SupportedResponse,
    },
    llm: async () => { throw new Error("no AI in these tests"); },
    treasury: "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8",
    authorizer: await generateKeyPairSigner(),
    rpcUrl: RPC,
    readChain: async () => { throw new Error("devnet is not used here"); },
    mainnet: { rpcUrl: RPC, readChain: async () => chain, solUsd: async () => 72.4 },
    now: () => new Date("2026-10-21T12:00:00Z"),
  });
});

const row = (tx: string, status: string, opts: { route?: string; scheme?: string; detail?: string | null; payer?: string | null; at?: string } = {}) =>
  db.run(
    "INSERT INTO payments (id, tx, network, route, scheme, amount, payer, status, detail, created_at) VALUES (?, ?, ?, ?, ?, '0', ?, ?, ?, ?)",
    `${tx}:${status}`, tx, MAINNET, opts.route ?? PRODUCTS.fund.example, opts.scheme ?? "exact", opts.payer === undefined ? "BuyerWallet" : opts.payer, status, opts.detail ?? null, opts.at ?? "2026-10-21T11:00:00Z",
  );
const redeem = (tx: string, ip = "10.0.0.1") => app.fetch(new Request(`https://api.afriradar.com/v1/redeem/${tx}`, { headers: { "cf-connecting-ip": ip } }));
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("redeem", () => {
  it("serves a pending payment once the chain shows it, as often as its buyer asks", async () => {
    chain = { status: "confirmed", received: 3_600n, slot: 1 };
    await row("PEND1", "pending");
    expect((await redeem("PEND1")).status).toBe(200);
    expect((await redeem("PEND1")).status).toBe(200); // a lost reply, a retry: still the buyer's
    const answers = await Promise.all([redeem("PEND1", "10.0.0.2"), redeem("PEND1")]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]); // someone else asking first uses nothing up
  });

  it("keeps the payer on the redeemed row, so the ledger still counts the buyer", async () => {
    chain = { status: "confirmed", received: 3_600n, slot: 1 };
    await row("PEND2", "pending", { payer: "RealBuyer" });
    await redeem("PEND2");
    expect(await db.first("SELECT status, payer, detail FROM payments WHERE id = 'PEND2:settled'")).toEqual({ status: "settled", payer: "RealBuyer", detail: "redeemed" });
    expect(await db.first("SELECT id FROM payments WHERE tx = 'PEND2' AND status = 'pending'")).toBeNull(); // not listed as pending too
    expect((await redeem("PEND2")).status).toBe(200); // and still the buyer's to ask again
  });

  it("refuses a payment whose data was served when it was paid", async () => {
    await row("PAID1", "settled");
    await row("PAID2", "settled", { detail: "recovered from chain after settlement_pending" });
    for (const tx of ["PAID1", "PAID2"]) {
      const r = await redeem(tx);
      expect(r.status).toBe(409);
      expect(await body(r)).toMatchObject({ status: "settled", error: "this payment's data was served when it was paid" });
    }
  });

  it("refuses a payment the chain showed failed, saying it was never charged", async () => {
    await row("FAIL1", "failed", { detail: "chain says failed" });
    const r = await redeem("FAIL1");
    expect(r.status).toBe(409);
    expect(await body(r)).toMatchObject({ status: "failed", error: "this payment failed and was never charged" });
  });

  it("reads the chain for a payment only reported failed, and serves it if it paid", async () => {
    chain = { status: "confirmed", received: 3_600n, slot: 1 };
    await row("FAIL2", "failed", { detail: "invalid_exact_svm_transaction_failed: settlement_pending, but failed to persist for retry" });
    expect((await redeem("FAIL2")).status).toBe(200);
    expect(await db.all("SELECT id, status FROM payments WHERE tx = 'FAIL2'")).toEqual([{ id: "FAIL2:settled", status: "settled" }]);
  });

  it("is open for a day after the payment, which also closes rows an earlier version marked redeemed", async () => {
    chain = { status: "confirmed", received: 3_600n, slot: 1 };
    await row("OLD1", "pending", { at: "2026-10-19T11:00:00Z" });
    await row("OLD2", "settled", { detail: "redeemed", at: "2026-10-01T09:00:00Z" });
    for (const tx of ["OLD1", "OLD2"]) {
      const r = await redeem(tx);
      expect(r.status).toBe(409);
      expect(await body(r)).toMatchObject({ error: "a payment can be redeemed for a day after it was made" });
    }
  });

  it("gives a final answer for a transaction that confirmed but paid the treasury nothing", async () => {
    chain = { status: "confirmed", received: 0n, slot: 1 };
    await row("ZERO1", "pending");
    const r = await redeem("ZERO1");
    expect(r.status).toBe(409);
    expect(await body(r)).toMatchObject({ error: "this transaction paid nothing to AfriRadar's treasury" });
  });

  it("keeps the redeem window running from the payment, not from the first redeem", async () => {
    chain = { status: "confirmed", received: 3_600n, slot: 1 };
    await row("WIN1", "pending", { at: "2026-10-20T13:00:00Z" }); // paid 23 hours before now
    expect((await redeem("WIN1")).status).toBe(200);
    expect(await db.first("SELECT created_at FROM payments WHERE id = 'WIN1:settled'")).toEqual({ created_at: "2026-10-20T13:00:00.000Z" });
  });

  it("fills in the payer of a redeemed row an earlier version left without one", async () => {
    chain = { status: "confirmed", received: 3_600n, slot: 1 };
    await row("PAYR1", "pending", { payer: "RealBuyer" });
    await row("PAYR1", "settled", { detail: "redeemed", payer: null });
    expect((await redeem("PAYR1")).status).toBe(200);
    expect(await db.first("SELECT payer FROM payments WHERE id = 'PAYR1:settled'")).toEqual({ payer: "RealBuyer" });
  });

  it("waits for the chain: an unconfirmed payment is not served", async () => {
    chain = { status: "unknown", received: 0n };
    await row("PEND3", "pending");
    expect((await redeem("PEND3")).status).toBe(409);
    chain = { status: "confirmed", received: 3_600n, slot: 1 };
    expect((await redeem("PEND3")).status).toBe(200); // and serves it once it shows
  });

  it("refuses what is not a data product, and what it has never seen", async () => {
    await row("ASK1", "pending", { route: PRODUCTS.ask.path, scheme: "upto" });
    expect((await redeem("ASK1")).status).toBe(400);
    expect((await redeem("NOSUCH")).status).toBe(404);
  });

  it("limits each visitor's redeems that read the chain, and counts nothing for one it refuses first", async () => {
    chain = { status: "unknown", received: 0n };
    await row("PEND9", "pending");
    for (let i = 0; i < 40; i++) expect((await redeem("NOSUCH", "10.9.9.9")).status).toBe(404); // no chain read, no count
    for (let i = 0; i < REDEEMS_PER_HOUR; i++) expect((await redeem("PEND9", "10.9.9.9")).status).toBe(409);
    expect((await redeem("PEND9", "10.9.9.9")).status).toBe(429);
    expect((await redeem("PEND9", "10.9.9.8")).status).toBe(409); // other visitors are not affected
  });

  it("answers a pending payment whose transaction landed and failed: never charged, and so recorded", async () => {
    chain = { status: "failed", received: 0n, slot: 1 };
    await row("PEND8", "pending");
    const r = await redeem("PEND8");
    expect(r.status).toBe(409);
    expect(await body(r)).toMatchObject({ status: "failed", error: "this payment failed and was never charged" });
    expect(await db.all("SELECT id, status, detail FROM payments WHERE tx = 'PEND8'")).toEqual([{ id: "PEND8:failed", status: "failed", detail: "chain says failed" }]);
  });
});

describe("the daily sweep of rate-limit counters", () => {
  it("deletes counters older than two days and keeps the rest, whatever they count", async () => {
    const db = sqlite();
    const put = (ns: string, k: string, at: string) => db.run("INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, '1', ?)", ns, k, at);
    await put("redeem", "ip:a:2026-11-18T10", "2026-11-18T10:00:00.000Z");
    await put("faucet", "day:2026-11-18", "2026-11-18T23:00:00.000Z");
    await put("redeem", "ip:a:2026-11-21T10", "2026-11-21T10:00:00.000Z");
    await put("payer-lock", "acct", "2026-11-01T00:00:00.000Z"); // not a counter: its own sweep
    expect(await sweepCounters(db, new Date("2026-11-21T12:00:00Z"))).toBe(2);
    expect((await db.all<{ ns: string }>("SELECT ns FROM kv ORDER BY ns")).map((r) => r.ns)).toEqual(["payer-lock", "redeem"]);
  });
});
