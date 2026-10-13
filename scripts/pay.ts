// Pays any x402 URL on Solana devnet with the buyer key and prints the receipt.
// Usage: npx tsx scripts/pay.ts <url> [<url> ...]
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";

const RPC = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const buyer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync("keys/buyer.json", "utf8"))));
const client = new x402Client()
  .register("solana:*", new ExactSvmScheme(buyer, { rpcUrl: RPC }))
  .register("solana:*", new UptoSvmScheme(buyer, { rpcUrl: RPC }));
const paidFetch = wrapFetchWithPayment(fetch, client);

let failed = false;
for (const url of process.argv.slice(2)) {
  const res = await paidFetch(url);
  const header = res.headers.get("PAYMENT-RESPONSE");
  const receipt = header ? decodePaymentResponseHeader(header) : null;
  console.log(url, res.status, (await res.text()).slice(0, 300));
  console.log("  receipt", JSON.stringify(receipt));
  if (res.status !== 200 || !receipt?.success) failed = true;
}
process.exitCode = failed ? 1 : 0;
