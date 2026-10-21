// Live proof that Solana, not our code, enforces the /v1/ask spending cap. It builds the exact
// channel-open transaction a buyer sends for a question (our demo wallet as the buyer), adds the
// payee's settle_and_seal for a claimed amount, and asks a validator to simulate the two together.
// A simulation moves nothing, so this can run on every click: the ceiling is accepted, the ceiling
// plus one micro-USDC is refused by the Solana Foundation payment-channel program.
import {
  appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createSolanaRpc, createTransactionMessage,
  decompileTransactionMessage, getBase64Codec, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder,
  getTransactionDecoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Blockhash, type MessagePartialSigner, type TransactionSigner,
} from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { buildSettleAndSealInstructions, PAYMENT_CHANNELS_PROGRAM_ID, signVoucher } from "x402-svm-channels";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/** The same attack sent for real on 18 October 2026 by scripts/cap-proof.ts (docs/cap-proof.json). */
export const RECORDED_ATTACK = {
  tx: "3rQ1eaaojMQ8i66S9fDg3gt12gnFiE2x4Enok8WRHZJ12uCzxB3JzTp1Jhc6zGv5444NVpttTGjxwHoGQTu6qkfG",
  claim: 10_001,
  ceiling: 10_000,
};

export type Trial = { claimMicroUsdc: number; accepted: boolean; error: unknown; programLog: string | null };
export type CapProof = {
  network: string;
  program: string;
  buyer: string;
  ceilingMicroUsdc: number;
  channel: string;
  trials: Trial[];
  verdict: "enforced" | "NOT ENFORCED";
  simulatedAt: string;
  recordedAttack: { tx: string; explorer: string; claimMicroUsdc: number; ceilingMicroUsdc: number };
};

export async function capProof(opts: {
  /** The upto requirements a real buyer gets in the 402 for POST /v1/ask. */
  requirements: PaymentRequirements;
  buyer: TransactionSigner;
  authorizer: MessagePartialSigner;
  rpcUrl: string;
  explorer: (sig: string) => string;
  now: () => Date;
}): Promise<CapProof> {
  const { requirements } = opts;
  const extra = (requirements.extra ?? {}) as { feePayer?: string; receiverAuthorizer?: string };
  if (!extra.feePayer || extra.receiverAuthorizer !== opts.authorizer.address) throw new Error("requirements are not this server's upto challenge");
  const created = (await new UptoSvmScheme(opts.buyer, { rpcUrl: opts.rpcUrl }).createPaymentPayload(2, requirements)) as unknown as {
    payload: { channelId: string; openTransaction: string; expiresAt: number };
  };
  const { channelId, openTransaction, expiresAt } = created.payload;
  const open = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Codec().encode(openTransaction)).messageBytes));
  // The open transaction carries its own compute budget; one budget per transaction, so drop it.
  const openIxs = open.instructions.filter((ix) => ix.programAddress !== COMPUTE_BUDGET);
  const blockhash = (open.lifetimeConstraint as { blockhash: Blockhash }).blockhash;
  const payee = createNoopSigner(extra.feePayer as Address);
  const rpc = createSolanaRpc(opts.rpcUrl);
  const ceiling = BigInt(requirements.amount);

  const trial = async (claim: bigint): Promise<Trial> => {
    const voucher = { channelId, cumulativeAmount: claim, expiresAt: BigInt(expiresAt) };
    const signatureBase58 = await signVoucher(opts.authorizer, voucher);
    const settle = buildSettleAndSealInstructions({ channelId, payeeSigner: payee, voucher: { ...voucher, authorizedSigner: opts.authorizer.address, signatureBase58 } });
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payee.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions([...openIxs, ...settle], m),
    );
    // Unsigned on purpose: a simulation with sigVerify off cannot be broadcast, so nothing can land.
    const { value } = await rpc
      .simulateTransaction(getBase64EncodedWireTransaction(compileTransaction(message)), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" })
      .send();
    const programLog = (value.logs ?? []).find((l) => l.includes(PAYMENT_CHANNELS_PROGRAM_ID) && /failed/i.test(l)) ?? null;
    return { claimMicroUsdc: Number(claim), accepted: !value.err, error: value.err ? JSON.parse(JSON.stringify(value.err, (_k, v) => (typeof v === "bigint" ? Number(v) : v))) : null, programLog };
  };

  const trials = [await trial(ceiling), await trial(ceiling + 1n)];
  return {
    network: requirements.network,
    program: PAYMENT_CHANNELS_PROGRAM_ID,
    buyer: opts.buyer.address,
    ceilingMicroUsdc: Number(ceiling),
    channel: channelId,
    trials,
    verdict: trials[0].accepted && !trials[1].accepted ? "enforced" : "NOT ENFORCED",
    simulatedAt: opts.now().toISOString(),
    recordedAttack: { tx: RECORDED_ATTACK.tx, explorer: opts.explorer(RECORDED_ATTACK.tx), claimMicroUsdc: RECORDED_ATTACK.claim, ceilingMicroUsdc: RECORDED_ATTACK.ceiling },
  };
}
