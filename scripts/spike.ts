// Day-1 spike: prove both x402 schemes settle on Solana devnet before building anything on top.
// Runs a self-hosted facilitator (:4022), a paid resource server (:4021) and a buyer, in one process.
import { readFileSync } from "node:fs";
import express from "express";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactFacilitator } from "@x402/svm/exact/facilitator";
import { ExactSvmScheme as ExactServer } from "@x402/svm/exact/server";
import { ExactSvmScheme as ExactClient } from "@x402/svm/exact/client";
import { InMemoryPaymentChannelStorage, UptoSvmScheme as UptoFacilitator } from "@x402/svm/upto/facilitator";
import { UptoSvmScheme as UptoServer } from "@x402/svm/upto/server";
import { UptoSvmScheme as UptoClient } from "@x402/svm/upto/client";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const RPC = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const key = (role: string) =>
  createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`keys/${role}.json`, "utf8"))));

const [feePayer, authorizer, treasury, buyer] = await Promise.all(
  ["facilitator", "authorizer", "treasury", "buyer"].map(key),
);

// 1. Facilitator
const svmSigner = toFacilitatorSvmSigner(feePayer, { defaultRpcUrl: RPC });
const facilitator = new x402Facilitator()
  .register(DEVNET, new ExactFacilitator(svmSigner))
  .register(DEVNET, new UptoFacilitator(svmSigner, { channelStorage: new InMemoryPaymentChannelStorage() }));
const fApp = express().use(express.json());
fApp.get("/supported", (_q, r) => r.json(facilitator.getSupported()));
fApp.post("/verify", async (q, r) => {
  const { paymentPayload, paymentRequirements } = q.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  r.json(await facilitator.verify(paymentPayload, paymentRequirements));
});
fApp.post("/settle", async (q, r) => {
  const { paymentPayload, paymentRequirements } = q.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  try {
    r.json(await facilitator.settle(paymentPayload, paymentRequirements));
  } catch (e) {
    console.error("settle error", e);
    r.status(500).json({ error: String(e) });
  }
});
const fServer = fApp.listen(4022);

// 2. Resource server
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: "http://localhost:4022" }))
  .register(DEVNET, new ExactServer())
  .register(DEVNET, new UptoServer({ receiverAuthorizerSigner: authorizer, rpcUrl: RPC }));
await resourceServer.initialize();

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /v1/funds/money-market/latest": {
        accepts: { scheme: "exact", price: "$0.001", network: DEVNET, payTo: treasury.address },
        description: "Latest SEC Nigeria money market fund yields",
        mimeType: "application/json",
      },
      "GET /v1/ask": {
        accepts: { scheme: "upto", price: "$0.05", network: DEVNET, payTo: treasury.address },
        description: "Answer a question from AfriRadar data, billed by datasets used",
        mimeType: "application/json",
      },
    },
    resourceServer,
    undefined,
    undefined,
    false,
  ),
);
app.get("/v1/funds/money-market/latest", (_q, r) => r.json({ asOf: "2026-10-02", funds: [{ name: "AIICO Money Market Fund", yield: 0.1664 }] }));
app.get("/v1/ask", (_q, r) => {
  setSettlementOverrides(r, { amount: "3000" }); // charge $0.003 of the $0.05 ceiling
  r.json({ answer: "spike", charged: "0.003" });
});
const server = app.listen(4021);

// 3. Buyer
const client = new x402Client()
  .register("solana:*", new ExactClient(buyer, { rpcUrl: RPC }))
  .register("solana:*", new UptoClient(buyer, { rpcUrl: RPC }));
const paidFetch = wrapFetchWithPayment(fetch, client);

let failed = false;
for (const path of ["/v1/funds/money-market/latest", "/v1/ask?q=test"]) {
  const res = await paidFetch(`http://localhost:4021${path}`);
  const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  const receipt = header ? decodePaymentResponseHeader(header) : null;
  console.log(path, res.status, await res.text());
  console.log("  receipt", JSON.stringify(receipt));
  if (res.status !== 200 || !receipt?.success) failed = true;
}
server.close();
fServer.close();
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(), 500);
