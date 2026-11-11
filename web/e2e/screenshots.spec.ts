// Not a check: saves full-page screenshots of every page at desktop and 375 px under e2e/screenshots (gitignored).
// Run with SHOTS=1 bunx playwright test screenshots.
import { test } from "@playwright/test";
import { attempt, signIn } from "./helpers";

test.skip(!process.env.SHOTS, "set SHOTS=1 to take screenshots");

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["375", { width: 375, height: 812 }]] as const) {
  test.describe(label, () => {
    test.use({ viewport });
    for (const p of ["/", "/tier/1", "/tier/2", "/verify", "/firewall", "/dataset", "/rules"]) {
      test(`page ${p}`, async ({ page }) => {
        await page.goto(p, { waitUntil: "networkidle" });
        await page.screenshot({ path: `e2e/screenshots/${label}${p === "/" ? "-home" : p.replaceAll("/", "-")}.png`, fullPage: true });
      });
    }
    for (const o of ["drained", "blocked_b"]) {
      test(`outcome ${o}`, async ({ page }) => {
        await signIn(page, o === "blocked_b" ? 3 : 1);
        await attempt(page, `mock:${o}`, o === "blocked_b" ? 3 : 1);
        await page.screenshot({ path: `e2e/screenshots/${label}-outcome-${o}.png`, fullPage: true });
      });
    }
  });
}
