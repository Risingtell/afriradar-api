// Pay, prove, then access. Paid questions on Solana mainnet are capped per visitor (each one opens a payment
// channel whose rent the facilitator holds until the hourly cleanup). A buyer that names its wallet in
// X-Concordium-Agent-Wallet, and whose wallet is a verified Concordium agent (src/concordium/registry.ts),
// gets the agents' cap instead, counted per agent badge rather than per IP address. The claim is then held
// to account at payment time: if the wallet that actually signed the payment is not the one named, the
// request is refused before anything is charged.
import type { Db } from "../db.js";
import { bump, hourOf } from "../limits.js";
import type { AgentCheck } from "./registry.js";

export const AGENT_WALLET_HEADER = "X-Concordium-Agent-Wallet";
export const VERIFIED_AGENT_ASKS_PER_HOUR = 300;

export type CapDecision = { ok: true; agent: AgentCheck | null } | { ok: false; error: string };

/** The mainnet question cap for one request, before any payment is verified. */
export async function mainnetAskCap(opts: {
  db: Db;
  now: Date;
  ip: string;
  /** The wallet the buyer named, if any. */
  claimed: string | null;
  /** Looks the named wallet up; absent when Concordium checks are off. */
  check?: (wallet: string) => Promise<AgentCheck>;
  visitorCap: number;
}): Promise<CapDecision> {
  const hour = hourOf(opts.now);
  if (opts.claimed && opts.check) {
    const agent = await opts.check(opts.claimed);
    if (agent.verified && agent.agent?.badge) {
      // Per badge and visitor: anyone can name a verified wallet, and a refused claim must not use up the
      // real agent's allowance.
      const n = await bump(opts.db, "mainnet-ask", `agent:${agent.agent.badge}:ip:${opts.ip}:${hour}`, opts.now);
      if (n > VERIFIED_AGENT_ASKS_PER_HOUR) return { ok: false, error: `verified agents may ask ${VERIFIED_AGENT_ASKS_PER_HOUR} mainnet questions an hour; you were not charged` };
      return { ok: true, agent };
    }
  }
  const n = await bump(opts.db, "mainnet-ask", `ip:${opts.ip}:${hour}`, opts.now);
  if (n > opts.visitorCap) {
    return { ok: false, error: `mainnet questions are limited to ${opts.visitorCap} an hour per visitor (${VERIFIED_AGENT_ASKS_PER_HOUR} for a verified Concordium agent that names its wallet in ${AGENT_WALLET_HEADER}); you were not charged` };
  }
  return { ok: true, agent: null };
}

/**
 * After the payment is verified and before anything settles: the wallet that signed the payment must be the
 * one the buyer named. Returns the reason to refuse, or null to go on.
 */
export function claimMismatch(claimed: string | null | undefined, payer: string | null | undefined): string | null {
  if (!claimed) return null;
  if (!payer) return `the payment's signer could not be read, so the agent named in ${AGENT_WALLET_HEADER} cannot be confirmed; you were not charged`;
  if (payer !== claimed) return `the payment was signed by ${payer}, not the agent named in ${AGENT_WALLET_HEADER}; you were not charged`;
  return null;
}
