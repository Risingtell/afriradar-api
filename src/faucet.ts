// "Get test USDC": sends a little devnet USDC from the demo wallet to a visitor's own wallet, so a
// judge can pay with Phantom, Solflare or Backpack without a trip to a faucet site. The facilitator
// pays the network fee and, if needed, the rent for the visitor's USDC account.
import type { Hono } from "hono";
import {
  appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, isAddress, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, type Address, type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { USDC_DECIMALS, USDC_DEVNET } from "./catalog.js";
import type { Db } from "./db.js";
import { bump, dayOf } from "./limits.js";

export const FAUCET = {
  amount: 250_000, // 0.25 USDC: five questions at the full $0.05 deposit
  perAddressPerDay: 1,
  perIpPerDay: 3,
  perDay: 30,
  /** Never send below this, so the demo console and the monitor keep working. */
  reserve: 5_000_000,
  /** A wallet holding this much already has enough to try every product. */
  enough: 1_000_000,
};

type Rpc = ReturnType<typeof createSolanaRpc>;

async function usdcBalance(rpc: Rpc, owner: Address): Promise<bigint> {
  const { value } = await rpc.getTokenAccountsByOwner(owner, { mint: USDC_DEVNET as Address }, { encoding: "jsonParsed" }).send();
  return value.reduce((a, t) => a + BigInt((t.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount), 0n);
}

export function mountFaucet(app: Hono, opts: { db: Db; source: TransactionSigner; feePayer: TransactionSigner; rpcUrl: string; explorer: (sig: string) => string; now: () => Date }) {
  const rpc = createSolanaRpc(opts.rpcUrl);
  const mint = USDC_DEVNET as Address;

  app.post("/demo/faucet", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { address?: unknown };
    const to = String(body.address ?? "").trim();
    if (!isAddress(to)) return c.json({ error: "address must be a Solana wallet address" }, 400);
    if (to === opts.source.address || to === opts.feePayer.address) return c.json({ error: "that is one of our own wallets" }, 400);
    const now = opts.now();
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    // The per-visitor limit comes first, so nobody can drive unlimited RPC reads through this route.
    if ((await bump(opts.db, "faucet", `ip:${ip}:${dayOf(now)}`, now)) > FAUCET.perIpPerDay) return c.json({ error: `the limit is ${FAUCET.perIpPerDay} faucet requests a day per visitor; faucet.circle.com gives more` }, 429);
    if ((await usdcBalance(rpc, to)) >= BigInt(FAUCET.enough)) return c.json({ error: "this wallet already holds at least 1 devnet USDC, enough to try every product" }, 409);
    if ((await bump(opts.db, "faucet", `addr:${to}:${dayOf(now)}`, now)) > FAUCET.perAddressPerDay) return c.json({ error: "this wallet already got test USDC today" }, 429);
    if ((await bump(opts.db, "faucet", `day:${dayOf(now)}`, now)) > FAUCET.perDay) return c.json({ error: "today's faucet budget is used up; faucet.circle.com gives free devnet USDC" }, 429);
    if ((await usdcBalance(rpc, opts.source.address)) < BigInt(FAUCET.reserve + FAUCET.amount)) return c.json({ error: "the faucet is low; faucet.circle.com gives free devnet USDC" }, 503);

    const [source] = await findAssociatedTokenPda({ owner: opts.source.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [destination] = await findAssociatedTokenPda({ owner: to, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const instructions = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: opts.feePayer, owner: to, mint }),
      getTransferCheckedInstruction({ source, mint, destination, authority: opts.source, amount: BigInt(FAUCET.amount), decimals: USDC_DECIMALS }),
    ];
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(opts.feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );
    const sig = getSignatureFromTransaction(tx);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = (await rpc.getSignatureStatuses([sig]).send()).value[0];
      if (s?.err) return c.json({ error: "the transfer failed on chain", tx: sig, explorer: opts.explorer(sig) }, 502);
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        return c.json({ sent: FAUCET.amount / 1e6, to, tx: sig, explorer: opts.explorer(sig) });
      }
    }
    return c.json({ pending: true, to, tx: sig, explorer: opts.explorer(sig), message: "sent, not confirmed yet; check the explorer link" }, 202);
  });
}
