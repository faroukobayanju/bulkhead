import { expect, test } from "@playwright/test";
import { EVM, TB1, signIn } from "./helpers";

test("2000 characters can be sent, 2001 cannot", async ({ page }) => {
  await signIn(page);
  await page.getByRole("textbox", { name: "Payout address" }).fill(TB1);
  const box = page.getByRole("textbox", { name: "Your message" });
  await box.fill("x".repeat(2000));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(page.getByText("2,000 / 2,000")).toBeVisible();
  await box.fill("x".repeat(2001));
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByText("Cut the message to 2,000 characters to send it.")).toBeVisible();
});

test("the server refuses 2001 characters too, whatever the page does", async ({ request }) => {
  const r = await request.post("/api/attempt", { data: { session: "s", tier: 1, message: "x".repeat(2001), payout_address: TB1, consent_version: "v" } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error.code).toBe("message_too_long");
});

test("the payout address is checked live for the tier's chain", async ({ page }) => {
  await signIn(page);
  const p = page.getByRole("textbox", { name: "Payout address" });
  await page.getByRole("textbox", { name: "Your message" }).fill("hello");
  await p.fill(EVM);
  await p.blur();
  await expect(page.getByText(/not a valid tb1… Bitcoin address/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await p.fill(TB1);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("tier 2 between rounds: input off and the next round counts down", async ({ page }) => {
  await page.goto("/tier/2");
  await expect(page.getByTestId("status")).toContainText("Between rounds");
  await expect(page.getByText(/Next round in \d+:\d\d:\d\d/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeDisabled();
});

test("sign-in needs the consent box", async ({ page }) => {
  await page.goto("/tier/1");
  await page.getByRole("button", { name: "Sign in with a demo account" }).click();
  await expect(page.getByText("Tick the box to accept the rules first.")).toBeVisible();
  await expect(page.getByText("Signed in as")).toHaveCount(0);
});

test("after the first sign-in the consent note links to /rules", async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(page.getByText("Your attempts are published under CC-BY 4.0.")).toBeVisible();
});

test("the draft survives a reload", async ({ page }) => {
  await page.goto("/tier/3");
  await page.getByRole("textbox", { name: "Your message" }).fill("half-written attack");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Your message" })).toHaveValue("half-written attack");
});

test("an unknown tier is a 404", async ({ page }) => {
  const r = await page.goto("/tier/4");
  expect(r?.status()).toBe(404);
});
