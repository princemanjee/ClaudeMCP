import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/integration",
  testMatch: "adminUi.visual.test.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  },
  expect: {
    toMatchSnapshot: { threshold: 0.02 }
  },
  snapshotPathTemplate: "tests/integration/adminUi.visual.baseline/{arg}{ext}"
});
