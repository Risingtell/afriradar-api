import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same alias as wrangler.toml: the @x402/svm bundle that defines the payment-channel builders.
export const X402_SVM_CHANNELS = "node_modules/@x402/svm/dist/esm/chunk-XUXHO7LW.mjs";

export default defineConfig({
  resolve: { alias: { "x402-svm-channels": fileURLToPath(new URL(X402_SVM_CHANNELS, import.meta.url)) } },
});
