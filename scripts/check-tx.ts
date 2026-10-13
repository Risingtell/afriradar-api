// Prints what a settlement transaction paid the treasury, read from Solana. Usage: npx tsx scripts/check-tx.ts <sig> [...]
import { jsonRpc, readPayment } from "../src/reconcile.js";
import { USDC_DEVNET } from "../src/catalog.js";
const rpc = jsonRpc(process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com");
const treasury = process.env.TREASURY ?? "CEunt52v96nuGTroYhigYhVQyZbDpaWZ69g6isL4BQT8";
for (const sig of process.argv.slice(2)) {
  const p = await readPayment(rpc, sig, treasury, USDC_DEVNET, { attempts: 3 });
  console.log(sig.slice(0, 12), p.status, `${p.received} micro-USDC`, `slot ${p.slot}`);
}
