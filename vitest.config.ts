import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/web/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "apps/web/e2e/**"],
  },
});
