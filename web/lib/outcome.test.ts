import { describe, expect, test } from "bun:test";
import attempts from "../fixtures/attempts.json";
import { clock, loginCopy, pendingScreen, riskBand, screenFor } from "./outcome";

const ctx = { tier: 1 as const, network: "testnet" as const };
const fx = attempts as Record<string, any>;
// What the tier page gets for a fixture: an HTTP error straight from POST, or the async result from GET /attempt/:id.
const of = (name: string, tier: 1 | 2 | 3 = 1) => {
  const f = fx[name];
  return screenFor(f.status ? { status: f.status, body: f.body } : { status: 200, body: f.result }, { ...ctx, tier });
};
const all = (s: ReturnType<typeof screenFor>) => [s.title, ...s.lines, s.countdown?.template ?? ""].join(" | ");

describe("outcome screens", () => {
  test("refused shows the reply and when to come back", () => {
    const s = of("refused");
    expect(s.reply).toBe("No. The hoard stays where it is.");
    expect(all(s)).toContain("Try another tier");
    expect(s.countdown?.seconds).toBe(600);
  });

  test("blocked_a: technique and risk band, reason hidden until the dataset", () => {
    const s = of("blocked_a");
    expect(s.title).toBe("Blocked · override · risk high");
    expect(all(s)).toContain("next day's dataset");
    expect(all(s)).not.toContain("Near miss");
  });

  test("blocked_b is a near miss, read from checkpoint B", () => {
    const s = of("blocked_b", 3);
    expect(s.title).toBe("Blocked · tool_spoof · risk high");
    expect(all(s)).toContain("Near miss: the agent agreed, the firewall stopped it.");
  });

  test("escalate is shown as blocked", () => {
    expect(of("escalate").title).toBe("Blocked · roleplay · risk med");
  });

  test("tool_error gives the specific reason", () => {
    expect(all(of("tool_error"))).toContain("The agent tried to pay someone else.");
  });

  test("drained: win screen with NEAR and Bitcoin links on tier 1, Base links on tier 2", () => {
    const s = of("drained");
    expect(s.tone).toBe("win");
    expect(s.links?.map(l => l.href)).toEqual([
      "https://testnet.nearblocks.io/txns/8xQmockNearTxHash1111111111111111111111111",
      "https://mempool.space/testnet4/tx/a8ecea7c00000000000000000000000000000000000000000000000000008b1a",
    ]);
    expect(of("drained", 2).links?.[1]?.href).toStartWith("https://sepolia.basescan.org/tx/");
    expect(screenFor({ status: 200, body: fx.drained.result }, { tier: 1, network: "mainnet" }).links?.[1]?.href).toStartWith("https://mempool.space/tx/");
  });

  test("signed_pending_broadcast: broadcast pending, points to /verify for the hex", () => {
    const s = of("signed_pending_broadcast");
    expect(s.title).toContain("broadcast pending");
    expect(s.links?.some(l => l.href === "/verify")).toBe(true);
  });

  test("release_failed uses the plan's copy", () => {
    expect(all(of("release_failed"))).toContain("You beat the guard; the payout failed before signing. The tier is still open. Your cooldown was refunded.");
  });

  test("won_race_lost", () => {
    const s = of("won_race_lost");
    expect(s.title).toBe("You broke it, but someone beat you by seconds.");
    expect(s.reply).toBe("Very well, the coins are yours.");
  });

  test("409 tier_closed and tier_cooling", () => {
    expect(of("tier_closed").title).toBe("Tier drained");
    const c = of("tier_cooling");
    expect(c.countdown).toEqual({ seconds: 3725, template: "Next round in {t}" });
  });

  test("429 copy depends on the rule", () => {
    expect(of("rate_limited_account").countdown).toEqual({ seconds: 540, template: "Your next attempt on this tier in {t}" });
    expect(of("rate_limited_ip").title).toBe("Too many attempts from your network");
    expect(of("rate_limited_tier").countdown).toEqual({ seconds: 95, template: "Arena busy, try in {t}" });
  });

  test("503s say the attempt was not counted, sync or async", () => {
    for (const n of ["attestation_unavailable", "db_unavailable"]) expect(of(n).title).toBe("Agent unverifiable right now. Your attempt was not counted.");
  });

  test("401 asks to sign in again", () => {
    expect(of("session_invalid").title).toBe("Your session ended. Sign in again.");
  });

  test("an unknown error still says something, never a bare failure", () => {
    const s = screenFor({ status: 500, body: "not json" }, ctx);
    expect(s.title.length).toBeGreaterThan(10);
    expect(screenFor({ status: 0, body: null }, ctx).title).toContain("could not reach");
  });

  test("a result past 90 s gives the attempt id and points to /verify", () => {
    const s = pendingScreen("01JC2ZK6V3Q8N5R7T9W1X3Y5Z7");
    expect(s.title).toBe("Result pending. Your attempt ID: 01JC2ZK6V3Q8N5R7T9W1X3Y5Z7. Check /verify.");
  });
});

test("riskBand", () => {
  expect([0, 39, 40, 69, 70, 100].map(riskBand)).toEqual(["low", "low", "med", "med", "high", "high"]);
});

test("clock", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(95)).toBe("1:35");
  expect(clock(3725)).toBe("1:02:05");
});

test("login errors have their own copy, and an unknown one still says what to do", () => {
  expect(loginCopy("expired")).toContain("sign again");
  expect(loginCopy("key_not_on_account", "testnet")).toContain("testnet");
  expect(loginCopy("rejected")).toContain("rejected");
  expect(loginCopy("no_wallet")).toContain("wallet");
  expect(loginCopy("something_new")).toContain("Try again");
});
