import { describe, expect, test } from "bun:test";
import { formatNative, mergePot, potText, tierStatus, type ContractTier } from "./tiers";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const base: ContractTier = {
  id: 1, chain: "Bitcoin", derivation_path: "bulkhead-tier-1", address: "tb1qexample", status: "Open",
  max_release: "31500", cooldown_s: 3600, rounds_left: 5, cooldown_until_ns: 0, evm: null,
};
const on = { paused: false, enabled: true, nowMs: NOW };

describe("tierStatus", () => {
  test("open", () => expect(tierStatus(base, on)).toEqual({ status: "open" }));
  test("cooling until cooldown_until_ns, then open again", () => {
    const until = (NOW + 90_000) * 1e6;
    expect(tierStatus({ ...base, cooldown_until_ns: until }, on)).toEqual({ status: "cooling", nextRoundAt: NOW + 90_000 });
    expect(tierStatus({ ...base, cooldown_until_ns: until }, { ...on, nowMs: NOW + 90_001 }).status).toBe("open");
  });
  test("releasing and drained carry the attempt", () => {
    expect(tierStatus({ ...base, status: { Releasing: { attempt_id: "A1", since_ns: 1 } } }, on)).toEqual({ status: "releasing", attemptId: "A1" });
    expect(tierStatus({ ...base, status: { Drained: { attempt_id: "A2" } } }, on)).toEqual({ status: "drained", attemptId: "A2" });
  });
  test("paused beats everything but not launched", () => {
    expect(tierStatus({ ...base, status: { Drained: { attempt_id: "A2" } } }, { ...on, paused: true }).status).toBe("paused");
    expect(tierStatus(base, { ...on, paused: true, enabled: false }).status).toBe("not_launched");
  });
  test("a tier the contract does not have, or one turned off, is not launched", () => {
    expect(tierStatus(null, on).status).toBe("not_launched");
    expect(tierStatus(base, { ...on, enabled: false }).status).toBe("not_launched");
  });
  test("contract state that cannot be read is unknown, never open", () => {
    expect(tierStatus(undefined, on).status).toBe("unknown");
  });
});

describe("pots", () => {
  test("native amounts: sats to BTC, base units to USDC, no float drift", () => {
    expect(formatNative("btc", 3150000n)).toBe("0.0315 BTC");
    expect(formatNative("btc", 1n)).toBe("0.00000001 BTC");
    expect(formatNative("btc", 0n)).toBe("0 BTC");
    expect(formatNative("evm", 200_000_000n)).toBe("200 USDC");
    expect(formatNative("evm", 12_345_678n)).toBe("12.345678 USDC");
  });

  test("a good read replaces the value; a failed read keeps the last good value and its time", () => {
    const a = mergePot(undefined, { native: "0.0315 BTC", usd: 30.1 }, "2026-11-10T12:00:00.000Z");
    expect(a).toEqual({ pot: { native: "0.0315 BTC", usd: 30.1 }, at: "2026-11-10T12:00:00.000Z", stale: false });
    const b = mergePot(a, null, "2026-11-10T12:00:30.000Z");
    expect(b).toEqual({ ...a, stale: true });
    expect(potText(b)).toBe("balance unavailable · last 0.0315 BTC at 12:00 UTC");
    expect(mergePot(b, { native: "0 BTC", usd: 0 }, "2026-11-10T12:01:00.000Z").stale).toBe(false);
  });

  test("never blank or zero when nothing was ever read", () => {
    expect(potText(mergePot(undefined, null, "2026-11-10T12:00:00.000Z"))).toBe("balance unavailable");
  });

  test("the dollar estimate follows the native amount, and is left out when there is none", () => {
    expect(potText({ pot: { native: "0.0315 BTC", usd: 3012.4 }, at: "x", stale: false })).toBe("0.0315 BTC ≈ $3,012");
    expect(potText({ pot: { native: "0.0315 BTC", usd: null }, at: "x", stale: false })).toBe("0.0315 BTC");
  });

  test("a drained tier shows 0 and the winning attempt", () => {
    expect(potText({ pot: { native: "0 BTC", usd: 0 }, at: "x", stale: false }, "01JC2ZK6V3Q8N5R7T9W1X3Y5Z7")).toBe("0 · won by 01JC2ZK6…");
  });
});
