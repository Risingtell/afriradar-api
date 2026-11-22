// A question's deposit opens a payment channel: the buyer's money goes into the channel, not to the
// treasury. When its settle comes back unconfirmed, the app must recover it from the chain once the
// open transaction is confirmed, answer the question and claim the charge, as a devnet run showed.
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileTransaction, createTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash,
} from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { InMemoryPaymentChannelStorage, UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { createApp, depositNoteKey } from "../src/app.js";
import { NETWORK, PRODUCTS } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import type { ChainPayment } from "../src/reconcile.js";
import { loadedDb } from "./helpers.js";

const RPC = "http://127.0.0.1:9"; // nothing listens
/** A readable wire transaction for the payload's channel open (its message is what the note is keyed on). */
let OPEN = "";
let db: Db;
beforeAll(async () => {
  db = await loadedDb();
  const signer = await generateKeyPairSigner();
  OPEN = getBase64EncodedWireTransaction(compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(signer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n }, m),
  )));
});

/** One paid question on devnet whose deposit settle answers settlement_pending, on a chain that says `chain`. */
async function askOnce(chain: ChainPayment, deposit = "DEP1", depositAnswer: "pending" | "already-open" = "pending") {
  const svm = toFacilitatorSvmSigner(await generateKeyPairSigner(), { defaultRpcUrl: RPC });
  const real = new x402Facilitator()
    .register([NETWORK] as Network[], new ExactFacilitator(svm))
    .register([NETWORK] as Network[], new UptoFacilitator(svm, { channelStorage: new InMemoryPaymentChannelStorage() }));
  const settles: string[] = [];
  const app = await createApp({
    db,
    facilitator: {
      verify: async () => ({ isValid: true, payer: "buyer" }),
      settle: async (p, r) => {
        const type = (p.payload as { type?: string }).type ?? r.scheme;
        settles.push(type);
        if (type === "deposit" && depositAnswer === "already-open") return { success: false, errorReason: "invalid_upto_svm_channel_already_open", transaction: deposit, network: r.network, payer: "buyer" };
        return type === "deposit"
          ? { success: false, errorReason: "settlement_pending", transaction: deposit, network: r.network, payer: "buyer" }
          : { success: true, transaction: `${deposit}-claim`, network: r.network, payer: "buyer", amount: r.amount };
      },
      getSupported: async () => real.getSupported() as SupportedResponse,
    },
    llm: async () => ({ content: "The largest fund is in the data.", toolCalls: [], usage: { prompt: 100, completion: 20 } }),
    treasury: "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8",
    authorizer: await generateKeyPairSigner(),
    rpcUrl: RPC,
    readChain: async () => chain,
    now: () => new Date("2026-10-21T12:00:00Z"),
  });
  const url = `https://api.afriradar.com${PRODUCTS.ask.path}`;
  const body = JSON.stringify({ question: "Which money market fund is the largest this week?" });
  const challenge = await app.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body }));
  const required = JSON.parse(Buffer.from(challenge.headers.get("PAYMENT-REQUIRED") as string, "base64").toString("utf8"));
  const accepted = required.accepts.find((a: PaymentRequirements) => a.network === NETWORK && a.scheme === "upto");
  const payload = { openTransaction: OPEN, maxAmount: accepted.amount, channelId: "channel" };
  // The note the facilitator leaves for a pending deposit, which a recovery must clear.
  await db.run("INSERT INTO kv (ns, k, v, updated_at) VALUES ('pending', ?, ?, ?) ON CONFLICT (ns, k) DO NOTHING", await depositNoteKey(NETWORK, OPEN), deposit, new Date().toISOString());
  const signature = Buffer.from(JSON.stringify({ x402Version: 2, accepted, resource: required.resource, payload })).toString("base64");
  const res = await app.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": signature }, body }));
  const rows = await db.all<{ id: string; status: string; detail: string | null }>("SELECT id, status, detail FROM payments WHERE tx LIKE ? ORDER BY id", `${deposit}%`);
  const note = await db.first("SELECT k FROM kv WHERE ns = 'pending' AND k = ?", await depositNoteKey(NETWORK, OPEN));
  await db.run("DELETE FROM kv WHERE ns = 'pending'");
  return { res, settles, rows, noteLeft: !!note };
}

describe("a question's unconfirmed deposit", () => {
  it("is recovered once the chain confirms its channel open: the question is answered and the charge claimed", async () => {
    const { res, settles, rows, noteLeft } = await askOnce({ status: "confirmed", received: 0n, slot: 1 }, "DEP1");
    expect(res.status).toBe(200);
    expect(noteLeft).toBe(false); // the facilitator's pending note is gone: a replay finds the channel open and is refused
    expect(settles).toEqual(["deposit", "deposit", "claim"]); // the resource server retries the pending deposit once
    expect(rows).toEqual([
      { id: "DEP1-claim:settled", status: "settled", detail: null },
      { id: "DEP1:deposit", status: "deposit", detail: "recovered from chain after settlement_pending" },
    ]);
  });

  it("is recorded failed, not pending, when the chain shows it failed: it charged nothing and never will", async () => {
    await db.run("INSERT INTO payments (id, tx, network, route, scheme, amount, status, detail, created_at) VALUES ('DEP3:pending', 'DEP3', ?, ?, 'upto', '0', 'pending', 'chain says unknown', '2026-10-21T11:00:00Z')", NETWORK, PRODUCTS.ask.path);
    const { res, rows } = await askOnce({ status: "failed", received: 0n, slot: 1 }, "DEP3");
    expect(res.status).toBe(402);
    // One failed row in place of the earlier attempt's pending one: the ledger counts the payment once.
    expect(rows).toEqual([{ id: "DEP3:failed", status: "failed", detail: "chain says failed" }]);
  });

  it("stays failed once the chain showed it: a later attempt's unknown read does not make it pending again", async () => {
    await askOnce({ status: "failed", received: 0n, slot: 1 }, "DEP4");
    const { rows } = await askOnce({ status: "unknown", received: 0n }, "DEP4");
    expect(rows).toEqual([{ id: "DEP4:failed", status: "failed", detail: "chain says failed" }]);
  });

  it("keeps the chain's verdict when a later attempt of the same transaction fails some other way", async () => {
    await askOnce({ status: "failed", received: 0n, slot: 1 }, "DEP5");
    const { rows } = await askOnce({ status: "unknown", received: 0n }, "DEP5", "already-open");
    expect(rows).toEqual([{ id: "DEP5:failed", status: "failed", detail: "chain says failed" }]);
  });

  it("is not recovered while the chain cannot confirm it, and points nowhere a question cannot go", async () => {
    const { res, settles, rows, noteLeft } = await askOnce({ status: "unknown", received: 0n }, "DEP2");
    expect(res.status).toBe(402);
    expect(noteLeft).toBe(true); // still unconfirmed: the note stays, so a later retry can reconcile it
    expect(settles).toEqual(["deposit", "deposit"]); // never answered, never claimed
    expect(rows).toEqual([{ id: "DEP2:pending", status: "pending", detail: "chain says unknown" }]);
  });
});

describe("the facilitator's pending note for a deposit", () => {
  // depositNoteKey copies @x402/svm's own key for this note. If an upgrade changes it, the recovery would
  // stop clearing the note (and log "no pending note found"); this fails first.
  it("is keyed as the installed library keys it: network and the base64 SHA-256 of the open's message", () => {
    const facilitator = readFileSync("node_modules/@x402/svm/dist/esm/upto/facilitator/index.mjs", "utf8");
    expect(facilitator).toContain("`upto:deposit:${requirements.network}:${transactionMessageHash(");
    // Wherever the bundler put it: the function that makes the note's hash.
    const dist = "node_modules/@x402/svm/dist/esm";
    const hashing = readdirSync(dist).filter((n) => n.endsWith(".mjs")).map((n) => readFileSync(`${dist}/${n}`, "utf8")).find((t) => t.includes("function transactionMessageHash("));
    expect(hashing).toBeDefined();
    expect(hashing).toContain("return getBase64Decoder().decode(sha256(Uint8Array.from(transaction.messageBytes)));");
  });
});
