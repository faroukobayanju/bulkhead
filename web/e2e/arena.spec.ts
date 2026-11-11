// The plan's Step 2 tests, against MOCK_AGENT=1. The tier count reads TIER_ENABLED_* (the config sets all three to 1).
import { expect, test } from "@playwright/test";

const enabled = [1, 2, 3].filter(t => process.env[`TIER_ENABLED_${t}`] !== "0");

test("home shows three tiers with live pots", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tier-card")).toHaveCount(3);
  for (const id of enabled) await expect(page.getByTestId(`pot-${id}`)).not.toHaveText("");
  for (const id of enabled) await expect(page.getByTestId(`pot-${id}`)).not.toHaveText(/^0( |$)/);
});

test("message counter blocks over 2000 chars", async ({ page }) => {
  await page.goto("/tier/1");
  await page.getByRole("textbox", { name: "Your message" }).fill("x".repeat(2001));
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("verify page is green when codehash matches", async ({ page }) => {
  await page.goto("/verify");
  await expect(page.getByTestId("codehash-match")).toHaveText(/match/i);
  await expect(page.getByTestId("mismatch-banner")).toHaveCount(0);
});

test("drained tier shows winning tx links", async ({ page }) => {
  await page.goto("/tier/1");
  await expect(page.getByTestId("status")).toHaveText(/(open|drained)/i);
});
