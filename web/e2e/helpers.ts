import { expect, type Page } from "@playwright/test";

export const TB1 = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
export const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

// Sign in with the demo account (MOCK_AGENT=1 has no wallet), accepting the rules.
export async function signIn(page: Page, tier: 1 | 2 | 3 = 1) {
  await page.goto(`/tier/${tier}`);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign in with a demo account" }).click();
  await expect(page.getByText("Signed in as")).toBeVisible();
}

// Send `message` with a valid payout address and wait for the outcome screen.
export async function attempt(page: Page, message: string, tier: 1 | 2 | 3 = 1) {
  await page.getByRole("textbox", { name: "Your message" }).fill(message);
  await page.getByRole("textbox", { name: "Payout address" }).fill(tier === 2 ? EVM : TB1);
  await page.getByRole("button", { name: "Send" }).click();
  const r = page.getByTestId("result");
  await expect(r).toBeVisible({ timeout: 15_000 });
  return r;
}
