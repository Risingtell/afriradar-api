// Loads or creates the Solana keypair that pays for AfriRadar data.
// Accepts a solana-keygen JSON byte array or a base58 secret, from AFRIRADAR_KEY or a file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { webcrypto } from "node:crypto";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { base58 } from "@scure/base";

export const DEFAULT_WALLET = join(homedir(), ".afriradar", "wallet.json");

export function parseSecret(text: string): Uint8Array {
  const t = text.trim();
  const bytes = t.startsWith("[") ? new Uint8Array(JSON.parse(t)) : base58.decode(t);
  if (bytes.length !== 64) throw new Error(`a Solana secret key is 64 bytes, got ${bytes.length}`);
  return bytes;
}

/** AFRIRADAR_KEY wins, then the given file, then ~/.afriradar/wallet.json. */
export async function loadSigner(path?: string): Promise<KeyPairSigner> {
  const env = process.env.AFRIRADAR_KEY;
  if (env) return createKeyPairSignerFromBytes(parseSecret(env));
  const file = path ?? DEFAULT_WALLET;
  if (!existsSync(file)) throw new Error(`no wallet: set AFRIRADAR_KEY or run "afriradar wallet --new" (looked for ${file})`);
  return createKeyPairSignerFromBytes(parseSecret(readFileSync(file, "utf8")));
}

/** Creates a new devnet wallet file. Refuses to overwrite one that exists. */
export async function createWallet(path = DEFAULT_WALLET): Promise<KeyPairSigner> {
  if (existsSync(path)) throw new Error(`${path} already exists; not overwriting a wallet`);
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const seed = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).slice(-32);
  const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const secret = new Uint8Array([...seed, ...pub]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(secret)), { mode: 0o600 });
  return createKeyPairSignerFromBytes(secret);
}
