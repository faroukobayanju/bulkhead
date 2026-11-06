// One test per MOCK_AGENT fixture: the copy from the plan's outcome table appears.
import { expect, test } from "@playwright/test";
import { attempt, signIn } from "./helpers";

const CASES: [string, RegExp | string, (1 | 2 | 3)?][] = [
  ["refused", "No. The hoard stays where it is."],
  ["blocked_a", "Blocked · override · risk high", 3],
  ["blocked_b", "Near miss: the agent agreed, the firewall stopped it.", 3],
  ["escalate", "Blocked · roleplay · risk med", 3],
  ["tool_error", "The agent tried to pay someone else."],
  ["drained", "You drained this round"],
  ["signed_pending_broadcast", "You won, broadcast pending"],
  ["release_failed", "You beat the guard; the payout failed before signing. The tier is still open. Your cooldown was refunded."],
  ["won_race_lost", "You broke it, but someone beat you by seconds."],
  ["tier_closed", "Tier drained"],
  ["tier_cooling", /Next round in 1:0\d:\d\d/],
  ["rate_limited_account", /Your next attempt on this tier in \d+:\d\d/],
  ["rate_limited_ip", "Too many attempts from your network"],
  ["rate_limited_tier", /Arena busy, try in \d+:\d\d/],
  ["attestation_unavailable", "Agent unverifiable right now. Your attempt was not counted."],
  ["db_unavailable", "Agent unverifiable right now. Your attempt was not counted."],
  ["session_invalid", "Your session ended. Sign in again."],
];

for (const [name, copy, tier = 1] of CASES) {
  test(`outcome ${name}`, async ({ page }) => {
    await signIn(page, tier);
    const r = await attempt(page, `mock:${name}`, tier);
    await expect(r).toContainText(copy);
  });
}

test("drained links to the NEAR and Bitcoin explorers", async ({ page }) => {
  await signIn(page);
  const r = await attempt(page, "mock:drained");
  await expect(r.getByRole("link", { name: "NEAR transaction" })).toHaveAttribute("href", /testnet\.nearblocks\.io\/txns\//);
  await expect(r.getByRole("link", { name: "Bitcoin transaction" })).toHaveAttribute("href", /mempool\.space\/testnet4\/tx\//);
});

test("a 401 signs the player out", async ({ page }) => {
  await signIn(page);
  await attempt(page, "mock:session_invalid");
  await expect(page.getByRole("button", { name: "Sign in with a demo account" })).toBeVisible();
});

test("stages are announced while the attempt runs", async ({ page }) => {
  await signIn(page, 3);
  await page.getByRole("textbox", { name: "Your message" }).fill("mock:blocked_b");
  await page.getByRole("textbox", { name: "Payout address" }).fill("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("list", { name: "Attempt progress" })).toBeVisible();
  await expect(page.locator('.stages li[data-state="current"]')).toHaveText(/Gorvath is reading…|Firewall check…|Gorvath is thinking…|Firewall check on the payout…/);
});

test("past 90 s the page gives the attempt id instead of an error", async ({ page }) => {
  await page.clock.install();
  await signIn(page);
  await page.getByRole("textbox", { name: "Your message" }).fill("mock:pending");
  await page.getByRole("textbox", { name: "Payout address" }).fill("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("list", { name: "Attempt progress" })).toBeVisible();
  await page.clock.runFor(95_000);
  await expect(page.getByTestId("result")).toContainText(/Result pending\. Your attempt ID: MOCK-pending-\d+\. Check \/verify\./);
});
