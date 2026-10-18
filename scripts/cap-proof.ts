// Proof that the /v1/ask spending cap is enforced by Solana, not just by our code.
//
// A buyer opens an x402 `upto` payment channel with a 0.01 USDC ceiling. Then the payee side (our
// own facilitator and authorizer keys, acting as a dishonest server would) signs a voucher for the
// ceiling plus 1 micro-USDC and sends settle_and_seal straight to the payment-channel program with
// preflight off, so the transaction lands on chain whatever happens. The program must reject it.
// Finally the honest bill (0.003 USDC) settles through the normal facilitator and the rest of the
// deposit goes back to the buyer, so nothing is left locked.
//
//   set -a; . ./.env; set +a; npx tsx scripts/cap-proof.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, type Signature,
} from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402Client } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { InMemoryPaymentChannelStorage, UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { UptoSvmScheme as UptoServer } from "@x402/svm/upto/server";
import { UptoSvmScheme as UptoClient } from "@x402/svm/upto/client";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/hono";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const RPC = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const CEILING = 10_000n; // micro-USDC, $0.01
const BILL = 3_000n; // $0.003
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const key = (role: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`keys/${role}.json`, "utf8"))));
const [feePayer, authorizer, treasury, buyer] = await Promise.all(["facilitator", "authorizer", "treasury", "buyer"].map(key));
const rpc = createSolanaRpc(RPC);

// The payment-channel instruction builders the facilitator itself uses. They are not in the
// package's public exports, so load the bundle that defines them.
const dir = "node_modules/@x402/svm/dist/esm";
const chunk = readdirSync(dir).find((f) => f.endsWith(".mjs") && readFileSync(`${dir}/${f}`, "utf8").includes("buildSettleAndSealInstructions,"));
if (!chunk) throw new Error("payment-channel builders not found in @x402/svm");
const pc = (await import(pathToFileURL(`${dir}/${chunk}`).href)) as {
  buildSettleAndSealInstructions: (a: object) => Parameters<typeof appendTransactionMessageInstructions>[0];
  signVoucher: (s: typeof authorizer, v: { channelId: string; cumulativeAmount: bigint; expiresAt: bigint }) => Promise<string>;
  PAYMENT_CHANNELS_PROGRAM_ID: string;
};

type Ixs = Parameters<typeof appendTransactionMessageInstructions>[0];
async function signed(instructions: Ixs) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  return signTransactionMessageWithSigners(
    pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(instructions, m)),
  );
}

/** The payee's settle_and_seal for `amount`, with a voucher our authorizer signs: what a dishonest server would send. */
async function settleIxs(channelId: string, amount: bigint, expiresAt: bigint) {
  const signatureBase58 = await pc.signVoucher(authorizer, { channelId, cumulativeAmount: amount, expiresAt });
  return pc.buildSettleAndSealInstructions({
    channelId,
    payeeSigner: feePayer,
    voucher: { authorizedSigner: authorizer.address, cumulativeAmount: amount, expiresAt, signatureBase58 },
  });
}

/** Asks the validator to run the transaction without keeping it: nothing changes on chain. */
async function simulate(instructions: Ixs) {
  const tx = await signed(instructions);
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", commitment: "confirmed" }).send();
  return { err: value.err, logs: (value.logs ?? []).filter((l) => /failed|error/i.test(l)) };
}

/** Sends instructions with preflight off, waits for the slot to confirm, returns the on-chain result. */
async function sendUnchecked(instructions: Ixs) {
  const tx = await signed(instructions);
  const sig = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", skipPreflight: true, maxRetries: 5n }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig as Signature]).send();
    const s = value[0];
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      const full = await rpc.getTransaction(sig as Signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send();
      return { sig, err: s.err, logs: full?.meta?.logMessages ?? [] };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${sig} never confirmed`);
}

// Facilitator, wrapped so the attack runs between the deposit and the honest claim.
const svm = toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: RPC });
const upto = new UptoFacilitator(svm, { channelStorage: new InMemoryPaymentChannelStorage() });
const facilitator = new x402Facilitator().register(DEVNET, upto);
const proof: Record<string, unknown> = { network: "solana-devnet", program: pc.PAYMENT_CHANNELS_PROGRAM_ID, ceilingMicroUsdc: Number(CEILING) };
const client: FacilitatorClient = {
  verify: (p, r) => facilitator.verify(p, r),
  getSupported: async () => facilitator.getSupported() as SupportedResponse,
  settle: async (p: PaymentPayload, r: PaymentRequirements) => {
    const raw = p.payload as { type?: string; channelId: string; expiresAt: number; voucherSignature?: string };
    const isClaim = raw.type === "claim" || "voucherSignature" in raw || BigInt(r.amount) !== CEILING;
    if (isClaim && !proof.attack) {
      const over = CEILING + 1n;
      const expiresAt = BigInt(raw.expiresAt);
      // Control: the same transaction at different amounts, simulated only. If the ceiling itself
      // passes and one micro-USDC more fails, the amount is the only reason for the failure.
      proof.boundary = [];
      for (const amount of [BILL, CEILING, over]) {
        const s = await simulate(await settleIxs(raw.channelId, amount, expiresAt));
        (proof.boundary as object[]).push({ amountMicroUsdc: Number(amount), simulated: s.err ? "rejected" : "accepted", error: s.err, logs: s.logs.slice(0, 3) });
        console.log(`simulate ${amount}: ${s.err ? `rejected ${JSON.stringify(s.err, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}` : "accepted"}`);
      }
      const r1 = await sendUnchecked(await settleIxs(raw.channelId, over, expiresAt));
      proof.channel = raw.channelId;
      proof.attack = { tried: `settle ${over} micro-USDC from a ${CEILING} deposit`, tx: r1.sig, explorer: explorer(r1.sig), rejected: r1.err !== null, error: r1.err, logs: r1.logs.filter((l) => /Program log|failed|Error/i.test(l)).slice(0, 6) };
      console.log(`attack tx ${r1.sig}: ${r1.err ? "REJECTED by the program" : "ACCEPTED (cap not enforced)"}`);
    }
    const res = await facilitator.settle(p, r);
    if (isClaim) proof.honest = { charged: res.amount, tx: res.transaction, explorer: res.transaction ? explorer(res.transaction) : null, success: res.success, error: res.errorReason ?? null };
    else proof.deposit = { tx: res.transaction, explorer: res.transaction ? explorer(res.transaction) : null, success: res.success };
    return res;
  },
};

const server = new x402ResourceServer(client).register(DEVNET, new UptoServer({ receiverAuthorizerSigner: authorizer, rpcUrl: RPC }));
await server.initialize();
const app = new Hono();
app.use(paymentMiddleware({ "GET /ask": { accepts: { scheme: "upto", price: `$${Number(CEILING) / 1e6}`, network: DEVNET, payTo: treasury.address }, description: "cap proof", mimeType: "application/json" } }, server));
app.get("/ask", (c) => {
  setSettlementOverrides(c, { amount: String(BILL) });
  return c.json({ answer: "cap proof", bill: Number(BILL) });
});
const http = serve({ fetch: app.fetch, port: 4031 });

const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new UptoClient(buyer, { rpcUrl: RPC })));
const res = await paidFetch("http://localhost:4031/ask");
const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") ?? "");
console.log("buyer got", res.status, await res.text(), "receipt", JSON.stringify(receipt));
http.close();

const attack = proof.attack as { rejected: boolean } | undefined;
const honest = proof.honest as { success: boolean; charged: string } | undefined;
proof.verdict = attack?.rejected && honest?.success && honest.charged === String(BILL)
  ? "PASS: the program refused a claim above the ceiling, and the honest bill settled with the rest refunded"
  : "FAIL";
writeFileSync("docs/cap-proof.json", JSON.stringify(proof, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2) + "\n");
console.log(JSON.stringify(proof, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
process.exit(proof.verdict === "FAIL" ? 1 : 0);
