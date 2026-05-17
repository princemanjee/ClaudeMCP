// Optional Playwright visual regression test for the admin UI.
//
// Run with: RUN_VISUAL=1 npm run test:visual
// (PowerShell: $env:RUN_VISUAL=1; npx playwright test ...)
//
// Requires a running dev server. Set ADMIN_URL + ADMIN_API_KEY to point at it.
// Skipped by default (RUN_VISUAL not set) so `npm test`/CI never run it.

import { test, expect } from "@playwright/test";

const RUN = process.env.RUN_VISUAL === "1";
const BASE = process.env.ADMIN_URL || "http://127.0.0.1:8899";
const API_KEY = process.env.ADMIN_API_KEY || "test-key";

test.describe("Admin UI — visual regression", () => {
  test.skip(!RUN, "Skipped by default. Run `npm run test:visual` against a live server.");

  for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE}/admin/ui/`);
        // Set theme preference before login so initial paint matches.
        await page.evaluate((t) => localStorage.setItem("claudemcp-theme", t), theme);
        await page.reload();
        await page.fill("#apikey", API_KEY);
        await page.click("button.primary");
        await page.waitForSelector(".app-shell");
      });

      for (const panel of ["dashboard", "backends", "router", "general", "archive"]) {
        test(`${panel} panel`, async ({ page }) => {
          const label = panel.charAt(0).toUpperCase() + panel.slice(1);
          await page.click(`.nav-item:has-text("${label}")`);
          await page.waitForTimeout(500); // allow paint + initial fetch
          await expect(page).toHaveScreenshot(`${theme}-${panel}.png`);
        });
      }
    });
  }
});
