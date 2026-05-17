import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The Playwright visual regression suite (Plan 12) is gated behind
    // RUN_VISUAL=1 and is run by `npm run test:visual` (Playwright runner) —
    // vitest must not try to execute it.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/integration/adminUi.visual.test.ts"
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/bin.ts"]
    }
  }
});
