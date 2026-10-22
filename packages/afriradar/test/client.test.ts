// Offline checks of the SDK: wallet parsing, free calls, refusing to pay without a signer, and refusal messages.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { createAfriRadar, AfriRadarError, refusal } from "../src/client.js";
import { createWallet, loadSigner, parseSecret } from "../src/wallet.js";

describe("wallet", () => {
  it("creates a wallet, loads it back, and refuses to overwrite it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "afr-")), "w.json");
    const made = await createWallet(path);
    delete process.env.AFRIRADAR_KEY;
    expect((await loadSigner(path)).address).toBe(made.address);
    await expect(createWallet(path)).rejects.toThrow(/not overwriting/);
  });

  it("rejects a secret that is not 64 bytes", () => {
    expect(() => parseSecret("[1,2,3]")).toThrow(/64 bytes/);
  });

  it("reads the same key from JSON or base58", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "afr-")), "w.json");
    await createWallet(path);
    const bytes = parseSecret((await import("node:fs")).readFileSync(path, "utf8"));
    const { base58 } = await import("@scure/base");
    expect(parseSecret(base58.encode(bytes))).toEqual(bytes);
    writeFileSync(path, " " + JSON.stringify(Array.from(bytes)) + "\n");
    expect(parseSecret((await import("node:fs")).readFileSync(path, "utf8"))).toEqual(bytes);
  });
});

describe("client", () => {
  const fakeFetch = (async (url: string) => {
    if (String(url).includes("/v1/search")) return Response.json({ results: [{ id: "money-market/x", name: "X", manager: "M", category: "money-market" }], url });
    return Response.json({ error: "nope" }, { status: 404 });
  }) as unknown as typeof fetch;

  it("free search works without a wallet and encodes the query", async () => {
    const api = createAfriRadar({ baseUrl: "https://api.test", fetch: fakeFetch });
    const r = (await api.search("stanbic & co")) as unknown as { url: string };
    expect(r.url).toBe("https://api.test/v1/search?q=stanbic%20%26%20co&limit=10");
  });

  it("a paid call without a signer fails before any request", async () => {
    let calls = 0;
    const api = createAfriRadar({ baseUrl: "https://api.test", fetch: (async () => { calls++; return new Response(); }) as unknown as typeof fetch });
    await expect(api.top("money-market")).rejects.toBeInstanceOf(AfriRadarError);
    expect(calls).toBe(0);
  });

  it("rejects a malformed fund id instead of building a wrong URL", async () => {
    const api = createAfriRadar({ baseUrl: "https://api.test", fetch: fakeFetch });
    expect(() => api.fund("no-slash")).toThrow(/category\/slug/);
  });

  it("explains a refused payment with the server's reason and the network", () => {
    const header = encodePaymentRequiredHeader({ x402Version: 2, error: "invalid_exact_svm_transaction_simulation_failed", resource: { url: "https://api.test/v1/kenya/unit-trusts" }, accepts: [] });
    const message = refusal(new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": header } }), "Payer1111", "mainnet");
    expect(message).toBe("payment refused (invalid_exact_svm_transaction_simulation_failed); you were not charged. Check that Payer1111 holds enough USDC on Solana mainnet.");
    expect(refusal(new Response("{}", { status: 402 }), "Payer1111", "devnet")).toMatch(/^payment refused; you were not charged\..*Solana devnet\.$/);
  });

  it("does not claim nothing was charged when a settlement may still land", () => {
    const failed = (errorReason: string) => new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, errorReason, transaction: "Tx1111", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }) } });
    const pending = refusal(failed("settlement_pending"), "Payer1111", "mainnet", "https://api.test");
    expect(pending).not.toMatch(/not charged/);
    expect(pending).toMatch(/Tx1111 was sent but not confirmed/);
    expect(pending).toMatch(/https:\/\/api\.test\/v1\/redeem\/Tx1111/);
    expect(refusal(failed("transaction_failed"), "Payer1111", "mainnet")).toMatch(/^payment refused \(transaction_failed\); you were not charged\./);
  });
});
