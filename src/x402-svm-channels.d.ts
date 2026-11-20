// Types for the payment-channel builders that @x402/svm uses internally but does not export.
// "x402-svm-channels" is an alias (wrangler.toml, vitest.config.ts) for the bundle file that
// defines them, pinned by package-lock; test/channels.test.ts fails if an upgrade moves it.
declare module "x402-svm-channels" {
  import type { Instruction, MessagePartialSigner, TransactionSigner } from "@solana/kit";

  export const PAYMENT_CHANNELS_PROGRAM_ID: string;
  export function signVoucher(signer: MessagePartialSigner, voucher: { channelId: string; cumulativeAmount: bigint; expiresAt: bigint }): Promise<string>;
  /** Builds a buyer-signed channel open, as the upto client does (test/lighthouse.test.ts). */
  export function buildOpenPaymentChannelTransaction(args: {
    payer: TransactionSigner;
    payee: string;
    mint: string;
    authorizedSigner: string;
    feePayer: string;
    tokenProgram: string;
    deposit: bigint;
    gracePeriod: number;
    openSlot: bigint;
    blockhash: { blockhash: string; lastValidBlockHeight: bigint };
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: number;
  }): Promise<{ channelId: string; deposit: bigint; openSlot: bigint; salt: bigint; transaction: string }>;
  /** The facilitator's static check of a buyer-built channel open; throws on anything it refuses. */
  export function verifyOpenTransaction(
    transactionBase64: string,
    expected: {
      authorizedSigner: string;
      feePayer: string;
      from: string;
      maxCap: bigint;
      mint: string;
      openSlot: bigint;
      payee: string;
      recipients: { recipient: string; bps: number }[];
      tokenProgram: string;
      withdrawDelay: number;
      recentSlot?: bigint;
      maxComputeUnits?: number;
      maxPriorityFeeMicroLamports?: number;
      maxRequiredSignatures?: number;
    },
  ): Promise<{ channelId: string; payer: string; deposit: bigint }>;
  export function buildSettleAndSealInstructions(args: {
    channelId: string;
    payeeSigner: TransactionSigner;
    voucher?: { authorizedSigner: string; cumulativeAmount: bigint; expiresAt: bigint; signatureBase58: string };
  }): Instruction[];
}
