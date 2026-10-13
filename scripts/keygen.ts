// Creates the devnet keypairs this project uses. Never overwrites an existing key.
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const ROLES = ["facilitator", "authorizer", "treasury", "buyer"] as const;
mkdirSync("keys", { recursive: true });

for (const role of ROLES) {
  const path = `keys/${role}.json`;
  if (existsSync(path)) {
    console.log(`${role.padEnd(12)} exists, kept`);
    continue;
  }
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  // 64-byte secret = 32-byte seed + 32-byte public key, the format solana-keygen writes.
  const seed = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).slice(-32);
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const secret = new Uint8Array([...seed, ...pub]);
  const signer = await createKeyPairSignerFromBytes(secret);
  writeFileSync(path, JSON.stringify(Array.from(secret)));
  console.log(`${role.padEnd(12)} ${signer.address}`);
}
