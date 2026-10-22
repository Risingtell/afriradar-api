// Turns a Wallet Standard wallet (Phantom, Solflare, Backpack...) into the @solana/kit signer the
// x402 client expects. The wallet signs its part of a transaction the facilitator will co-sign.
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  address, assertIsTransactionWithinSizeLimit, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder,
  type Blockhash, type Transaction, type TransactionModifyingSigner, type TransactionWithLifetime,
} from "@solana/kit";

export type WalletChain = "solana:devnet" | "solana:mainnet";

type Connect = { connect: () => Promise<{ accounts: readonly WalletAccount[] }> };
type Disconnect = { disconnect: () => Promise<void> };
type SignTx = { signTransaction: (...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]) => Promise<{ signedTransaction: Uint8Array }[]> };

export function solanaWallets(): Wallet[] {
  return getWallets().get().filter((w) => "standard:connect" in w.features && "solana:signTransaction" in w.features);
}

// MetaMask's Solana wallet connects on mainnet and signs on that network whatever chain we pass
// (checked in its 13.52 inpage script), so it can pay on mainnet but not for a devnet request.
export const signsMainnetOnly = (w: Wallet) => /^metamask/i.test(w.name);

export async function disconnect(wallet: Wallet): Promise<void> {
  await (wallet.features["standard:disconnect"] as Disconnect | undefined)?.disconnect();
}

export function onWalletsChange(cb: () => void): () => void {
  const api = getWallets();
  const a = api.on("register", cb);
  const b = api.on("unregister", cb);
  return () => { a(); b(); };
}

// A modifying signer, because wallets may change the transaction while signing: Phantom and Solflare
// append Lighthouse guard instructions that protect the user. The x402 facilitator allows up to three
// Lighthouse (or Memo) instructions after the payment, so we hand the wallet's version back as signed
// and let the facilitator judge it; anything it does not allow comes back as a clear "not charged".
// `chain` is read at signing time, so one connection can pay on whichever network the visitor picks.
export async function connect(wallet: Wallet, chain: () => WalletChain): Promise<{ account: WalletAccount; signer: TransactionModifyingSigner }> {
  const { accounts } = await (wallet.features["standard:connect"] as Connect).connect();
  const account = accounts.find((a) => a.chains.some((ch) => ch.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error(`${wallet.name} returned no account`);
  const sign = wallet.features["solana:signTransaction"] as SignTx;
  const enc = getTransactionEncoder();
  const dec = getTransactionDecoder();
  const msgDec = getCompiledTransactionMessageDecoder();
  const me = address(account.address);
  const signer: TransactionModifyingSigner = {
    address: me,
    async modifyAndSignTransactions(txs) {
      const out = await sign.signTransaction(...txs.map((tx) => ({ account, transaction: new Uint8Array(enc.encode(tx)), chain: chain() })));
      return out.map(({ signedTransaction }, i) => {
        const signed = dec.decode(signedTransaction) as Transaction;
        if (!signed.signatures[me]) throw new Error(`${wallet.name} did not sign`);
        const original = txs[i] as Transaction & Partial<TransactionWithLifetime>;
        const blockhash = msgDec.decode(signed.messageBytes).lifetimeToken as Blockhash;
        const before = original.lifetimeConstraint as { blockhash?: string; lastValidBlockHeight?: bigint } | undefined;
        const lifetimeConstraint = { blockhash, lastValidBlockHeight: before?.blockhash === blockhash && before.lastValidBlockHeight !== undefined ? before.lastValidBlockHeight : 2n ** 63n };
        const result = { ...signed, lifetimeConstraint };
        assertIsTransactionWithinSizeLimit(result);
        return result;
      });
    },
  };
  return { account, signer };
}
