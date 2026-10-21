// The live cap proof imports @x402/svm's payment-channel builders through an alias to one bundle
// file. A package upgrade renames that file; this test makes the break loud instead of a broken deploy.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as channels from "x402-svm-channels";
import { X402_SVM_CHANNELS } from "../vitest.config.js";

describe("x402-svm-channels alias", () => {
  it("points wrangler and vitest at the same bundle", () => {
    expect(readFileSync("wrangler.toml", "utf8")).toContain(`"x402-svm-channels" = "./${X402_SVM_CHANNELS}"`);
  });

  it("resolves to the builders the cap proof uses", () => {
    expect(typeof channels.buildSettleAndSealInstructions).toBe("function");
    expect(typeof channels.signVoucher).toBe("function");
    expect(channels.PAYMENT_CHANNELS_PROGRAM_ID).toBe("CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX");
  });
});
