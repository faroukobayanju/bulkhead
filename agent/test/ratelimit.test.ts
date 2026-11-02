import { describe, expect, test } from "bun:test";
import { RateLimiter, rateLimitScale } from "../src/ratelimit";

type Tier = 1 | 2 | 3;
const k = (account = "a.near", ip = "1.1.1.1", tier: Tier = 1) => ({ account, ip, tier });
const rejection = (r: ReturnType<RateLimiter["check"]>) => {
  if (r.ok) throw new Error("expected a rejection");
  return r;
};
const count = (n: number, f: (i: number) => boolean) => Array.from({ length: n }, (_, i) => f(i)).filter(Boolean).length;

describe("check", () => {
  test("1 per account per tier per 10 min", () => {
    const rl = new RateLimiter();
    const t0 = 1_000_000;
    const results = Array.from({ length: 6 }, (_, i) => rl.check(k(), t0 + i * 1000));
    expect(results.filter(r => r.ok).length).toBe(1);
    const blocked = rejection(results[1]);
    expect(blocked.retryAfterS).toBe(599);
    expect(blocked.rule).toBe("account");
    expect(rl.check(k(), t0 + 600_000).ok).toBe(true);
  });

  test("same account, different tier is allowed", () => {
    const rl = new RateLimiter();
    expect(rl.check(k("a.near", "1.1.1.1", 1), 0).ok).toBe(true);
    expect(rl.check(k("a.near", "1.1.1.1", 2), 0).ok).toBe(true);
  });

  test("20 per IP per hour", () => {
    const rl = new RateLimiter();
    const oks = Array.from({ length: 25 }, (_, i) => rl.check(k(`u${i}.near`, "9.9.9.9", 1), i)).filter(r => r.ok).length;
    expect(oks).toBe(20);
  });

  test("120 per tier per hour globally", () => {
    const rl = new RateLimiter();
    const oks = Array.from({ length: 130 }, (_, i) => rl.check(k(`u${i}.near`, `10.0.${i >> 8}.${i & 255}`, 3), i)).filter(r => r.ok).length;
    expect(oks).toBe(120);
  });

  test("a full tier names the tier rule", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 120; i++) expect(rl.check(k(`u${i}.near`, `10.0.0.${i}`, 3), 0).ok).toBe(true);
    const r = rejection(rl.check(k("fresh.near", "10.9.9.9", 3), 1000));
    expect(r.rule).toBe("tier");
    expect(r.retryAfterS).toBe(3599);
  });

  test("rejection names the rule with the longest wait: ip beats account", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 20; i++) expect(rl.check(k(`u${i}.near`, "9.9.9.9"), 0).ok).toBe(true);
    // u0 is blocked by its account (599 s left) and by the IP (3599 s left)
    const r = rejection(rl.check(k("u0.near", "9.9.9.9"), 1000));
    expect(r).toEqual({ ok: false, retryAfterS: 3599, rule: "ip" });
  });

  test("rejection names the rule with the longest wait: account beats ip", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 20; i++) expect(rl.check(k(`u${i}.near`, "9.9.9.9"), i).ok).toBe(true);
    expect(rl.check(k("late.near", "2.2.2.2"), 3_500_000).ok).toBe(true);
    // account has 599 s left, the old IP hits expire in 99 s
    const r = rejection(rl.check(k("late.near", "9.9.9.9"), 3_501_000));
    expect(r).toEqual({ ok: false, retryAfterS: 599, rule: "account" });
  });

  test("a rejected check records no hit on any window", () => {
    const rl = new RateLimiter();
    expect(rl.check(k("a.near", "1.1.1.1"), 0).ok).toBe(true);
    // rejected by the account rule, from an IP and tier that are otherwise fresh
    expect(rl.check(k("a.near", "7.7.7.7"), 1000).ok).toBe(false);
    // the IP window kept all 20 slots...
    expect(count(25, i => rl.check(k(`ip${i}.near`, "7.7.7.7", 2), 2000).ok)).toBe(20);
    // ...and the tier-1 window kept 119 of 120 (a.near's first hit holds the other)
    expect(count(130, i => rl.check(k(`t${i}.near`, `10.1.0.${i}`), 3000).ok)).toBe(119);
  });
});

describe("refund", () => {
  test("lets the same account retry at once", () => {
    const rl = new RateLimiter();
    expect(rl.check(k(), 0).ok).toBe(true);
    expect(rl.check(k(), 1000).ok).toBe(false);
    rl.refund(k(), 1000);
    expect(rl.check(k(), 1000).ok).toBe(true);
    expect(rl.check(k(), 2000).ok).toBe(false);
  });

  test("gives back exactly one slot on the shared ip and tier windows", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 20; i++) expect(rl.check(k(`u${i}.near`, "9.9.9.9"), i).ok).toBe(true);
    expect(rl.check(k("x.near", "9.9.9.9"), 100).ok).toBe(false);
    rl.refund(k("u19.near", "9.9.9.9"), 100);
    expect(count(5, i => rl.check(k(`n${i}.near`, "9.9.9.9"), 200).ok)).toBe(1);

    const t = new RateLimiter();
    for (let i = 0; i < 120; i++) expect(t.check(k(`u${i}.near`, `10.0.0.${i}`, 2), 0).ok).toBe(true);
    t.refund(k("u5.near", "10.0.0.5", 2), 0);
    expect(count(5, i => t.check(k(`n${i}.near`, `10.2.0.${i}`, 2), 1).ok)).toBe(1);
  });

  test("drops the refunded hit's timestamp, not the newest entry, from shared windows", () => {
    const rl = new RateLimiter();
    expect(rl.check(k("a.near", "9.9.9.9"), 0).ok).toBe(true);
    expect(rl.check(k("b.near", "9.9.9.9"), 1000).ok).toBe(true);
    for (let i = 0; i < 18; i++) expect(rl.check(k(`u${i}.near`, "9.9.9.9"), 2000).ok).toBe(true);
    rl.refund(k("a.near", "9.9.9.9"), 2000);
    // the hit at 0 is gone and b's at 1000 is still live: 19 entries, so exactly one slot is free
    expect(count(5, i => rl.check(k(`n${i}.near`, "9.9.9.9"), 3_600_500).ok)).toBe(1);
  });

  test("with no hit it is a no-op that cannot touch other keys' hits", () => {
    const rl = new RateLimiter();
    expect(rl.check(k("a.near", "9.9.9.9"), 0).ok).toBe(true);
    expect(rl.check(k("b.near", "9.9.9.9"), 0).ok).toBe(true);
    rl.refund(k("never.near", "9.9.9.9"), 0); // never checked
    rl.refund(k("a.near", "9.9.9.9"), 0); // real refund: ip window holds b's hit only
    rl.refund(k("a.near", "9.9.9.9"), 0); // second refund finds nothing
    // 19 slots left on the IP: 20 minus b's hit
    expect(count(25, i => rl.check(k(`n${i}.near`, "9.9.9.9"), 1).ok)).toBe(19);
  });

  test("ignores a hit that already left the account window", () => {
    const rl = new RateLimiter();
    expect(rl.check(k(), 0).ok).toBe(true);
    rl.refund(k(), 600_000);
    // the old hit was gone anyway; the IP window still counts it
    expect(count(25, i => rl.check(k(`n${i}.near`, "1.1.1.1"), 600_001).ok)).toBe(19);
  });

  test("only touches the refunded tier", () => {
    const rl = new RateLimiter();
    expect(rl.check(k("a.near", "1.1.1.1", 1), 0).ok).toBe(true);
    expect(rl.check(k("a.near", "1.1.1.1", 2), 0).ok).toBe(true);
    rl.refund(k("a.near", "1.1.1.1", 1), 0);
    expect(rl.check(k("a.near", "1.1.1.1", 1), 1).ok).toBe(true);
    expect(rl.check(k("a.near", "1.1.1.1", 2), 1).ok).toBe(false);
  });
});

describe("memory", () => {
  test("rejected checks from many IPs and accounts allocate nothing", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 120; i++) rl.check(k(`u${i}.near`, `10.0.0.${i}`), 0);
    const size = rl.size;
    for (let i = 0; i < 500; i++) expect(rl.check(k(`spam${i}.near`, `11.0.${i >> 8}.${i & 255}`), 1000).ok).toBe(false);
    expect(rl.size).toBe(size);
  });

  test("keys whose windows are empty are dropped", () => {
    const rl = new RateLimiter();
    for (const tier of [1, 2, 3] as const)
      for (let i = 0; i < 120; i++) expect(rl.check(k(`u${i}.near`, `10.${tier}.0.${i}`, tier), 0).ok).toBe(true);
    expect(rl.size).toBeGreaterThan(700);
    expect(rl.check(k("fresh.near", "3.3.3.3"), 3_600_001).ok).toBe(true);
    expect(rl.size).toBe(3); // fresh's account, ip and tier keys
  });

  test("refunding the only hit drops its keys", () => {
    const rl = new RateLimiter();
    expect(rl.check(k("a.near", "1.1.1.1", 1), 0).ok).toBe(true);
    expect(rl.size).toBe(3);
    rl.refund(k("a.near", "1.1.1.1", 1), 0);
    expect(rl.size).toBe(0);
  });
});

describe("scale", () => {
  test("0.01 shortens the windows 100x", () => {
    const rl = new RateLimiter(0.01);
    expect(rl.check(k(), 0).ok).toBe(true);
    expect(rejection(rl.check(k(), 5999))).toEqual({ ok: false, retryAfterS: 1, rule: "account" });
    expect(rl.check(k(), 6000).ok).toBe(true);
    const ip = new RateLimiter(0.01);
    for (let i = 0; i < 20; i++) expect(ip.check(k(`u${i}.near`, "9.9.9.9"), 0).ok).toBe(true);
    expect(ip.check(k("x.near", "9.9.9.9"), 35_999).ok).toBe(false);
    expect(ip.check(k("x.near", "9.9.9.9"), 36_000).ok).toBe(true);
  });

  test.each([0, -1, 1.5, NaN, Infinity])("constructor refuses %p", s => {
    expect(() => new RateLimiter(s)).toThrow();
  });
});

describe("rateLimitScale", () => {
  test("is 1 when unset, whatever the network", () => {
    expect(rateLimitScale({})).toBe(1);
    expect(rateLimitScale({ NEAR_NETWORK: "mainnet" })).toBe(1);
    expect(rateLimitScale({ NEAR_NETWORK: "testnet" })).toBe(1);
  });

  test("is accepted on testnet", () => {
    expect(rateLimitScale({ NEAR_NETWORK: "testnet", RATE_LIMIT_SCALE: "0.01" })).toBe(0.01);
    expect(rateLimitScale({ NEAR_NETWORK: "testnet", RATE_LIMIT_SCALE: "1" })).toBe(1);
  });

  test.each([undefined, "mainnet", "", "TESTNET"])("refuses when set and NEAR_NETWORK is %p", network => {
    expect(() => rateLimitScale({ NEAR_NETWORK: network, RATE_LIMIT_SCALE: "0.01" })).toThrow(/testnet/);
    expect(() => rateLimitScale({ NEAR_NETWORK: network, RATE_LIMIT_SCALE: "1" })).toThrow(/testnet/);
  });

  test.each(["abc", "NaN", "0", "-1", "-0.5", "1.5", "100", "Infinity", ""])("refuses %p on testnet", scale => {
    expect(() => rateLimitScale({ NEAR_NETWORK: "testnet", RATE_LIMIT_SCALE: scale })).toThrow();
  });
});
