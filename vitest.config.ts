import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["lib/__tests__/**/*.test.ts"],
    environment: "node",
    env: {
      TPX_DISABLE_KV: "1", // tests must never touch the real Upstash DB
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
