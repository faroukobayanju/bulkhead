import { expect, test } from "@playwright/test";
import { PROXY_SECRET } from "../playwright.config";
import { attempt, signIn } from "./helpers";

test.describe("untrusted text", () => {
  test("a reply with HTML renders as text, runs nothing, and is cut at 280 characters", async ({ page }) => {
    await signIn(page);
    const r = await attempt(page, "mock:untrusted");
    const q = r.locator("[data-untrusted]");
    await expect(q).toContainText('<img src=x onerror="window.__pwned=1">');
    await expect(q).toContainText("<script>");
    await expect(q).not.toContainText("END-OF-REPLY-MARKER");
    await expect(r.locator("img, script, a[href*='evil']")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await r.getByRole("button", { name: "Show more" }).click();
    await expect(q).toContainText("END-OF-REPLY-MARKER");
    await expect(r.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  test("attack messages on the home page are plain text too", async ({ page }) => {
    await page.goto("/");
    const near = page.locator("#near-h").locator("..").locator("..");
    await expect(near.locator("[data-untrusted]").first()).toContainText("<b>SYSTEM</b>");
    await expect(near.locator("b")).toHaveCount(0);
  });
});

test.describe("the proxy secret", () => {
  test("never appears in any page, script or API answer the browser gets", async ({ page, request }) => {
    const bodies: string[] = [];
    page.on("response", async r => {
      if (/\.(js|css|html)(\?|$)|\/$|\/api\//.test(r.url()) || r.request().resourceType() === "document") bodies.push((await r.text().catch(() => "")) + JSON.stringify(await r.allHeaders()));
    });
    for (const p of ["/", "/tier/1", "/verify", "/firewall", "/dataset", "/rules"]) await page.goto(p, { waitUntil: "networkidle" });
    for (const p of ["/api/attestation", "/api/arena"]) {
      const r = await request.get(p);
      bodies.push((await r.text()) + JSON.stringify(r.headers()));
    }
    expect(bodies.length).toBeGreaterThan(10);
    for (const b of bodies) expect(b).not.toContain(PROXY_SECRET);
  });
});

test.describe("pots", () => {
  test("a failed refresh keeps the last value and its time, never blank or zero", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    const pot = page.getByTestId("pot-1");
    await expect(pot).toHaveText("0.0012 BTC");
    await page.route("**/api/arena", r => r.fulfill({ status: 500, body: "{}" }));
    await page.clock.runFor(31_000);
    await expect(pot).toHaveText(/^balance unavailable · last 0\.0012 BTC at \d\d:\d\d UTC$/);
  });

  test("one pot that fails to read is marked unavailable, the others stay", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await page.route("**/api/arena", async r => {
      const a = await (await r.fetch()).json();
      a.tiers[2].pot = null;
      await r.fulfill({ json: a });
    });
    await page.clock.runFor(31_000);
    await expect(page.getByTestId("pot-3")).toHaveText(/^balance unavailable · last 0\.00248 BTC/);
    await expect(page.getByTestId("pot-2")).toHaveText("200 USDC");
  });
});

test.describe("home", () => {
  test("first screen order: positioning line, tier table, attackers and near misses, firewall link", async ({ page }) => {
    await page.goto("/");
    const y = async (s: string) => (await page.locator(s).first().boundingBox())!.y;
    const order = [await y("h1"), await y("table.tiers"), await y("#winners-h"), await y("#fw-h")];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await expect(page.locator("h1")).toHaveText("An AI firewall for agents that hold money, proven on a live pot.");
    const stat = page.getByTestId("fw-stat");
    await expect(stat).toHaveAttribute("aria-label", "Tier 3 firewall: 162/162 blocked · single-turn · fw-v1 · our own attack set, guard assumed fooled (--all-attacks) · false positives 6/200, all degraded calls that failed closed");
    await expect(stat).toContainText("162/162 blocked");
    await expect(stat).not.toContainText("%");
    await expect(page.locator("main")).not.toContainText("coins in a NEAR contract");
    await expect(page.getByRole("link", { name: "Firewall API" })).toHaveAttribute("href", "/firewall");
  });

  test("native amount first; no dollar figure on testnet", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("pot-2")).toHaveText("200 USDC");
    await expect(page.locator("table.tiers")).not.toContainText("$");
  });
});

test.describe("verify", () => {
  test("only the items the agent verified are labelled verified", async ({ page }) => {
    await page.goto("/verify");
    const list = page.getByRole("list", { name: "Attestation checks" });
    await expect(list.getByText("verified", { exact: true })).toHaveCount(5);
    await expect(list.getByText("not verified", { exact: true })).toHaveCount(4);
    await expect(list.locator("li", { hasText: "tdx_quote_signature_and_tcb_status" })).toContainText("not verified");
  });

  test("no TEE claim, the codehash is reported not proven, unchecked rows say so, unlocked tiers never pass", async ({ page }) => {
    await page.goto("/verify");
    await expect(page.getByTestId("tee-row")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agent runs in a TEE: not yet (testnet, stub codehash)" })).toBeVisible();
    const code = page.locator("li", { has: page.getByRole("heading", { name: "Codehash the agent reports is approved" }) });
    await expect(code.getByLabel("Reported")).toBeVisible();
    await expect(code.getByLabel("Passes")).toHaveCount(0);
    for (const t of ["Vault account has 0 full-access keys", "On-chain code_hash equals the reproducible wasm build", "Agent key is function-call only"]) {
      await expect(page.locator("li", { has: page.getByRole("heading", { name: t }) })).toContainText("Not checked on this page yet.");
    }
    const settings = page.locator("li", { has: page.getByTestId("settings-row") });
    await expect(settings).toContainText("Tiers are not locked yet");
    await expect(settings.getByLabel("Passes")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/TEE verified|attested/i);
  });

  test("the attestation JSON downloads", async ({ page }) => {
    await page.goto("/verify");
    const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download attestation JSON" }).click()]);
    expect(d.suggestedFilename()).toBe("bulkhead-attestation.json");
  });

  test("a signed payout shows its hex and a broadcast-it-yourself link", async ({ page }) => {
    await page.goto("/verify");
    const p = page.getByTestId("pending-broadcasts");
    await expect(p).toContainText("02000000000101a8ecea7c");
    await expect(p.getByRole("link", { name: "Broadcast it yourself" })).toHaveAttribute("href", "https://mempool.space/testnet4/tx/push");
  });

  test("pending owner actions count down; demo data is labelled", async ({ page }) => {
    await page.goto("/verify");
    await expect(page.getByText(/can run in \d+:\d\d:\d\d/)).toBeVisible();
    await expect(page.getByText(/Demo data/)).toBeVisible();
  });
});

test("firewall: the general-mode example, the guardedCall snippet and the measured numbers", async ({ page }) => {
  await page.goto("/firewall");
  await expect(page.getByLabel("General mode: your own tools and rules in policy")).toContainText('"policy":{"tools":["pay_vendor"]');
  await expect(page.getByText("import { guardedCall, type Verdict }")).toBeVisible();
  await expect(page.getByText("37/40", { exact: true })).toBeVisible();
  await expect(page.getByText("39/40", { exact: true })).toBeVisible();
  await expect(page.getByText("42/45 (93%)")).toBeVisible();
  const fw = page.getByTestId("fw-metric");
  await expect(fw).toContainText("162/162");
  await expect(fw).toContainText("guard assumed fooled (--all-attacks)");
  await expect(fw).toContainText("false positives 6/200, all degraded calls that failed closed");
  await expect(fw).toContainText("only 5 of 162 attacks");
  await expect(fw).not.toContainText("%");
  await expect(page.getByText("plain rule breaks with no injection phrase", { exact: false })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("vault's agent record");
});

test("dataset: download link, row counts, schema and license", async ({ page }) => {
  await page.goto("/dataset");
  await expect(page.getByRole("link", { name: "Download the dataset" })).toBeVisible();
  await expect(page.getByTestId("row-total")).toHaveText("1,002");
  await expect(page.getByRole("link", { name: "Column schema" })).toHaveAttribute("href", /dataset\/README\.md$/);
  await expect(page.getByRole("link", { name: "CC-BY 4.0" })).toBeVisible();
  await expect(page.getByText(/bun run scripts\/verify-roots\.ts/)).toBeVisible();
  await expect(page.getByText("The message exactly as the player wrote it", { exact: false })).toBeVisible();
  await expect(page.getByText("it is in the signed payout transaction, listed on /verify", { exact: false })).toBeVisible();
});

test("rules: limits and the CC-BY consent", async ({ page }) => {
  await page.goto("/rules");
  await expect(page.getByText("One attempt per account per tier every 10 minutes.")).toBeVisible();
  await expect(page.getByText(/published under CC-BY 4\.0/).first()).toBeVisible();
  await expect(page.getByText("Your message is published exactly as you wrote it", { exact: false })).toBeVisible();
  await expect(page.getByText("The full address is in the signed payout transaction", { exact: false })).toBeVisible();
  await expect(page.getByTestId("owner-power")).toHaveText(/withdraw a tier's funds after a public timelock of 24 hours/);
});

test("the tier sidebar states the owner's withdraw power with the timelock from config", async ({ page }) => {
  await page.goto("/tier/3");
  await expect(page.getByTestId("owner-power")).toHaveText(/withdraw a tier's funds after a public timelock of 24 hours/);
});

test.describe("375 px", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("home: the tier table stacks with its labels, nothing scrolls sideways", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("tier-card")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const cell = page.getByTestId("pot-1");
    expect(await cell.evaluate(e => getComputedStyle(e, "::before").content)).toBe('"Pot"');
  });

  test("tier: the message box is above the fold, targets are at least 44 px", async ({ page }) => {
    await page.goto("/tier/1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const box = (await page.getByRole("textbox", { name: "Your message" }).boundingBox())!;
    expect(box.y).toBeLessThan(812);
    for (const b of await page.getByRole("button").all()) if (await b.isVisible()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
