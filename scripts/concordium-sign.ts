// Signs the CIS-8 binding for AfriRadar's two Solana wallets: "this ed25519 key belongs to Concordium account
// OWNER". The bytes come from Concordium's registry service (build_cis8_canonical_bytes) and are signed here,
// offline, with the key files in keys/ (never printed, never sent). The output is public: the signature goes
// on chain with the binding, and is pasted into src/concordium/agents.ts.
//
//   npx tsx scripts/concordium-sign.ts
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, signBytes } from "@solana/kit";
import { AFRIRADAR_AGENTS, OWNER } from "../src/concordium/agents.js";
import { registryRpc, solanaKeyHex } from "../src/concordium/registry.js";

const rpc = registryRpc();
const KEYS: Record<string, string> = { seller: "keys/treasury.json", buyer: "keys/buyer.json" };

for (const agent of Object.values(AFRIRADAR_AGENTS)) {
  const file = process.env.KEYS_DIR ? `${process.env.KEYS_DIR}/${KEYS[agent.id].split("/")[1]}` : KEYS[agent.id];
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(file, "utf8"))));
  if (signer.address !== agent.wallet) throw new Error(`${file} is ${signer.address}, not ${agent.id}'s wallet ${agent.wallet}`);
  const keyHex = solanaKeyHex(agent.wallet);
  const canon = (await rpc("build_cis8_canonical_bytes", {
    network: "testnet",
    concordium_account: OWNER,
    external_namespace: agent.solanaNetwork,
    external_key_namespace: agent.solanaNetwork,
    external_key_type: "ed25519",
    external_public_key_hex: keyHex,
    proof_scheme: "solana-ed25519",
  })) as { bytes_hex: string };
  const bytes = Uint8Array.from(canon.bytes_hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const sig = await signBytes(signer.keyPair.privateKey, bytes);
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  console.log(`${agent.id}: wallet ${agent.wallet}`);
  console.log(`  canonical bytes sha: ${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`);
  console.log(`  cis8Signature: "${hex}",`);
}
