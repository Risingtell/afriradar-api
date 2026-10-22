// Prints SOL and USDC balances for every project wallet, and with --setup opens the treasury's USDC
// account if missing (the facilitator pays the rent). Devnet by default; --mainnet reads and writes
// Solana mainnet through MAINNET_RPC_URL.
//   set -a; . ./.env; set +a; npx tsx scripts/balances.ts [--mainnet] [--setup]
import { readFileSync } from "node:fs";
import {
  address,
  appendTransactionMessageInstruction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { USDC_DEVNET, USDC_MAINNET } from "../src/catalog.js";

const MAINNET = process.argv.includes("--mainnet");
const RPC = MAINNET ? process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com" : process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const USDC = address(MAINNET ? USDC_MAINNET : USDC_DEVNET);
console.log(`Solana ${MAINNET ? "mainnet" : "devnet"}, USDC ${USDC}`);
const rpc = createSolanaRpc(RPC);
const key = (role: string) =>
  createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`keys/${role}.json`, "utf8"))));

const roles = ["facilitator", "authorizer", "treasury", "buyer"];
const signers = Object.fromEntries(await Promise.all(roles.map(async (r) => [r, await key(r)] as const)));

async function usdc(owner: string): Promise<{ ata: string; amount: string | null }> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  try {
    const b = await rpc.getTokenAccountBalance(ata).send();
    return { ata, amount: b.value.uiAmountString };
  } catch {
    return { ata, amount: null };
  }
}

for (const r of roles) {
  const s = signers[r];
  const sol = Number((await rpc.getBalance(s.address).send()).value) / 1e9;
  const u = await usdc(s.address);
  console.log(`${r.padEnd(12)} ${s.address}  SOL ${sol.toFixed(4)}  USDC ${u.amount ?? "(no account)"}`);
}

if (process.argv.includes("--setup")) {
  const treasury = signers.treasury.address;
  const t = await usdc(treasury);
  if (t.amount !== null) {
    console.log("treasury USDC account already open:", t.ata);
  } else {
    const payer = signers.facilitator;
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const ix = getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: address(t.ata),
      owner: address(treasury),
      mint: USDC,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    assertIsTransactionWithBlockhashLifetime(tx);
    const subs = createSolanaRpcSubscriptions(RPC.replace(/^http/, "ws"));
    await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs })(tx, { commitment: "confirmed" });
    console.log("opened treasury USDC account", t.ata, "tx", getSignatureFromTransaction(tx));
  }
}
