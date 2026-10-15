// Turns a Wallet Standard wallet (Phantom, Solflare, Backpack...) into the @solana/kit signer the
// x402 client expects. The wallet signs its part of a transaction the facilitator will co-sign.
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { address, getTransactionDecoder, getTransactionEncoder, type TransactionPartialSigner } from "@solana/kit";

export const DEVNET_CHAIN = "solana:devnet";

type Connect = { connect: () => Promise<{ accounts: readonly WalletAccount[] }> };
type SignTx = { signTransaction: (...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]) => Promise<{ signedTransaction: Uint8Array }[]> };

export function solanaWallets(): Wallet[] {
  return getWallets().get().filter((w) => "standard:connect" in w.features && "solana:signTransaction" in w.features);
}

export function onWalletsChange(cb: () => void): () => void {
  const api = getWallets();
  const a = api.on("register", cb);
  const b = api.on("unregister", cb);
  return () => { a(); b(); };
}

export async function connect(wallet: Wallet): Promise<{ account: WalletAccount; signer: TransactionPartialSigner }> {
  const { accounts } = await (wallet.features["standard:connect"] as Connect).connect();
  const account = accounts.find((a) => a.chains.some((ch) => ch.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error(`${wallet.name} returned no account`);
  const sign = wallet.features["solana:signTransaction"] as SignTx;
  const enc = getTransactionEncoder();
  const dec = getTransactionDecoder();
  const me = address(account.address);
  const signer: TransactionPartialSigner = {
    address: me,
    async signTransactions(txs) {
      const out = await sign.signTransaction(...txs.map((tx) => ({ account, transaction: new Uint8Array(enc.encode(tx)), chain: DEVNET_CHAIN })));
      return out.map(({ signedTransaction }, i) => {
        const signed = dec.decode(signedTransaction);
        const before = txs[i].messageBytes;
        const after = signed.messageBytes;
        // A wallet that rewrites the transaction (adds fees, swaps the payer) breaks the facilitator's checks.
        if (before.length !== after.length || before.some((b, j) => b !== after[j])) throw new Error(`${wallet.name} changed the transaction while signing; try another wallet`);
        const sig = signed.signatures[me];
        if (!sig) throw new Error(`${wallet.name} did not sign`);
        return { [me]: sig };
      });
    },
  };
  return { account, signer };
}
