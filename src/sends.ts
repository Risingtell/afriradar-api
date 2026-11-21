// What the fee payer's sends tell the payer lock (src/netfee.ts): which transactions the RPC turned
// away, so nothing of them reached the network. Kept out of worker.ts, the Worker's entry module,
// whose named exports the runtime reads as entrypoints.
import {
  getBase64Encoder, getTransactionDecoder, isSolanaError,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, SOLANA_ERROR__JSON_RPC__INVALID_REQUEST, SOLANA_ERROR__JSON_RPC__PARSE_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import type { Network } from "@x402/core/types";
import { fingerprint } from "./netfee.js";

/** A wire transaction's fingerprint, or undefined if it cannot be read. */
async function fingerprintOf(wire: string): Promise<string | undefined> {
  try {
    return await fingerprint(new Uint8Array(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes));
  } catch {
    return undefined;
  }
}

/**
 * The fee payer's signer, noting in `refused` (by fingerprint) each transaction whose latest send the
 * RPC turned away. A later send of the same transaction clears it first: only the latest send counts.
 */
export function watchingRefusals<S extends { sendTransaction: (transaction: string, network: Network) => Promise<string> }>(signer: S, refused: Map<string, number>): S {
  return {
    ...signer,
    sendTransaction: async (transaction: string, network: Network) => {
      const fp = await fingerprintOf(transaction);
      if (fp) refused.delete(fp);
      try {
        return await signer.sendTransaction(transaction, network);
      } catch (e) {
        if (fp && sendRefusedBy(e)) {
          const at = Date.now();
          for (const [k, t] of refused) if (at - t > 120_000) refused.delete(k);
          refused.set(fp, at);
        }
        throw e;
      }
    },
  };
}

/** HTTP answers that mean the request was turned away before any node took it: bad request, auth, size, rate limit. */
const REFUSED_HTTP = new Set([400, 401, 403, 413, 429]);
/**
 * JSON-RPC answers a node gives before it forwards a transaction: a request it cannot read, or (not
 * expected while the facilitator skips preflight, but a refusal if it comes) a signature that fails.
 */
const REFUSED_JSON_RPC = new Set<number>([
  SOLANA_ERROR__JSON_RPC__PARSE_ERROR, SOLANA_ERROR__JSON_RPC__INVALID_REQUEST, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
]);

/**
 * Whether an error from sending a transaction proves the RPC turned it away, so nothing reached the
 * network. Only answers that come before forwarding count. Anything else (a failed connection, a 5xx,
 * an internal error a provider returns after forwarding, a code we do not know) leaves the outcome unknown.
 */
export function sendRefusedBy(e: unknown): boolean {
  if (!isSolanaError(e)) return false;
  const code = e.context.__code;
  if (code === SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) return REFUSED_HTTP.has(Number((e.context as { statusCode?: unknown }).statusCode));
  return REFUSED_JSON_RPC.has(code as number);
}
