import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "dist-server/**", "node_modules/**"],
    // Scrypt tests intentionally exercise production-strength work factors and
    // can exceed Vitest's 5s default on a busy developer workstation.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
