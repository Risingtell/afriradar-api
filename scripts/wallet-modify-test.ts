// Pays the API through the demo page's wallet adapter (web/wallet.ts) with a stand-in wallet that
// does what Phantom and Solflare do: it changes the transaction while signing, here by appending a
// Memo instruction. Proves the adapter hands the changed transaction on and the facilitator accepts it.
//   set -a; . ./.env; set +a; npx tsx scripts/wallet-modify-test.ts [url]
import { readFileSync } from "node:fs";
import {
  appendTransactionMessageInstruction, compileTransaction, createKeyPairSignerFromBytes, decompileTransactionMessage,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, address,
} from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import type { Wallet } from "@wallet-standard/base";
import { connect } from "../web/wallet.js";

const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const url = process.argv[2] ?? "https://api.afriradar.com/v1/kenya/unit-trusts/sanlam";
const buyer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync("keys/buyer.json", "utf8"))));
let changed = 0;

const account = { address: buyer.address, publicKey: new Uint8Array(), chains: ["solana:devnet"], features: ["solana:signTransaction"] } as const;
const wallet = {
  name: "Stand-in wallet that adds a memo",
  features: {
    "standard:connect": { connect: async () => ({ accounts: [account] }) },
    "solana:signTransaction": {
      signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
        Promise.all(inputs.map(async ({ transaction }) => {
          const tx = getTransactionDecoder().decode(transaction);
          const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
          const withMemo = appendTransactionMessageInstruction({ programAddress: MEMO, data: new TextEncoder().encode("wallet guard") }, message);
          const signed = await partiallySignTransaction([buyer.keyPair], compileTransaction(withMemo));
          changed++;
          return { signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)) };
        })),
    },
  },
} as unknown as Wallet;

const { signer } = await connect(wallet);
const paid = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmScheme(signer, { rpcUrl: RPC })).register("solana:*", new UptoSvmScheme(signer, { rpcUrl: RPC })));
const ask = url.endsWith("/v1/ask");
const res = await paid(url, ask ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "How big is the Kenyan unit trust market?" }) } : undefined);
const header = res.headers.get("PAYMENT-RESPONSE");
const receipt = header ? decodePaymentResponseHeader(header) : null;
if (!header) {
  const required = res.headers.get("PAYMENT-REQUIRED");
  console.log(res.status, `wallet changed ${changed} transaction(s)`, required ? JSON.stringify(JSON.parse(Buffer.from(required, "base64").toString())).slice(0, 600) : await res.text());
  process.exit(1);
}
console.log(res.status, `wallet changed ${changed} transaction(s)`, JSON.stringify(receipt));
console.log((await res.text()).slice(0, 160));
process.exit(res.status === 200 && receipt?.success && changed > 0 ? 0 : 1);
