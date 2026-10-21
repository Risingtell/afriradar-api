// Types for the payment-channel builders that @x402/svm uses internally but does not export.
// "x402-svm-channels" is an alias (wrangler.toml, vitest.config.ts) for the bundle file that
// defines them, pinned by package-lock; test/channels.test.ts fails if an upgrade moves it.
declare module "x402-svm-channels" {
  import type { Instruction, MessagePartialSigner, TransactionSigner } from "@solana/kit";

  export const PAYMENT_CHANNELS_PROGRAM_ID: string;
  export function signVoucher(signer: MessagePartialSigner, voucher: { channelId: string; cumulativeAmount: bigint; expiresAt: bigint }): Promise<string>;
  export function buildSettleAndSealInstructions(args: {
    channelId: string;
    payeeSigner: TransactionSigner;
    voucher?: { authorizedSigner: string; cumulativeAmount: bigint; expiresAt: bigint; signatureBase58: string };
  }): Instruction[];
}
