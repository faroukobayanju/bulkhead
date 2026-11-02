import { describe, expect, test } from "bun:test";
import { memoryCounter, utcDay } from "../src/counter";
import { LIMITS, makeBudget } from "../src/firewall/budget";
import { ipKey, SlidingWindow } from "../src/firewall/window";

describe("memoryCounter", () => {
  test("adds, reads and starts at zero", async () => {
    const c = memoryCounter();
    expect(await c.get("a")).toBe(0);
    expect(await c.add("a", 2)).toBe(2);
    expect(await c.add("a", 3)).toBe(5);
    expect(await c.add("a", -1)).toBe(4);
    expect(await c.get("a")).toBe(4);
    expect(await c.get("b")).toBe(0);
  });

  test("a capped add stops at the cap and adds nothing past it", async () => {
    const c = memoryCounter();
    expect(await c.add("a", 1, 2)).toBe(1);
    expect(await c.add("a", 1, 2)).toBe(2);
    expect(await c.add("a", 1, 2)).toBeNull();
    expect(await c.get("a")).toBe(2);
  });

  test("concurrent capped adds never pass the cap", async () => {
    const c = memoryCounter();
    const r = await Promise.all(Array.from({ length: 20 }, () => c.add("a", 1, 7)));
    expect(r.filter(x => x !== null).length).toBe(7);
    expect(await c.get("a")).toBe(7);
  });

  test("utcDay is the UTC date", () => {
    expect(utcDay(Date.UTC(2026, 10, 2, 23, 59, 59, 999))).toBe("2026-11-02");
    expect(utcDay(Date.UTC(2026, 10, 3, 0, 0, 0, 0))).toBe("2026-11-03");
  });
});

describe("budget pools", () => {
  const T0 = Date.UTC(2026, 10, 2, 12);
  const setup = (limits = {}) => {
    const clock = { now: T0 };
    const counter = memoryCounter();
    return { clock, counter, budget: makeBudget({ counter, clock: () => clock.now, limits }) };
  };
  const times = async (n: number, f: () => Promise<boolean>) => (await Promise.all(Array.from({ length: n }, f))).filter(Boolean).length;

  test("default limits are 300 per key and 2000 global for the API, 300 playground, 3000 arena", () => {
    expect(LIMITS).toEqual({ apiKey: 300, apiGlobal: 2000, playground: 300, arena: 3000 });
  });

  test("one key exhausting its daily quota blocks neither another key nor the arena", async () => {
    const { budget } = setup({ apiKey: 3 });
    expect(await times(10, () => budget.chargeApi("key-a"))).toBe(3);
    expect(await budget.chargeApi("key-a")).toBe(false);
    expect(await budget.chargeApi("key-b")).toBe(true);
    expect(await budget.chargeArena()).toBe(true);
    expect(await budget.chargePlayground()).toBe(true);
  });

  test("exhausting the API pool never affects the arena or the playground", async () => {
    const { budget } = setup({ apiKey: 100, apiGlobal: 4, playground: 2, arena: 2 });
    for (let i = 0; i < 4; i++) expect(await budget.chargeApi(`key-${i}`)).toBe(true);
    expect(await budget.chargeApi("key-new")).toBe(false);
    expect(await times(2, () => budget.chargeArena())).toBe(2);
    expect(await times(2, () => budget.chargePlayground())).toBe(2);
  });

  test("exhausting the arena pool, or the playground, leaves the API alone", async () => {
    const { budget } = setup({ playground: 1, arena: 1 });
    await budget.chargeArena();
    await budget.chargePlayground();
    expect(await budget.chargeArena()).toBe(false);
    expect(await budget.chargePlayground()).toBe(false);
    expect(await budget.chargeApi("key-a")).toBe(true);
  });

  test("the global API pool is exact under concurrency", async () => {
    const { budget } = setup({ apiGlobal: 5 });
    expect(await times(40, () => budget.chargeApi(`k${Math.random()}`))).toBe(5);
  });

  test("a call refused by the global pool is not left on the key's own count", async () => {
    const { budget, counter, clock } = setup({ apiKey: 3, apiGlobal: 1 });
    expect(await budget.chargeApi("key-a")).toBe(true);
    expect(await budget.chargeApi("key-b")).toBe(false);
    expect(await counter.get(`fw:key:key-b:${utcDay(clock.now)}`)).toBe(0);
  });

  test("a key over its own quota does not eat the global pool", async () => {
    const { budget, counter, clock } = setup({ apiKey: 2, apiGlobal: 100 });
    for (let i = 0; i < 10; i++) await budget.chargeApi("key-a");
    expect(await counter.get(`fw:api:${utcDay(clock.now)}`)).toBe(2);
  });

  test("days reset at 00:00 UTC", async () => {
    const { budget, clock } = setup({ apiKey: 1, apiGlobal: 1, playground: 1, arena: 1 });
    clock.now = Date.UTC(2026, 10, 2, 23, 59, 59, 999);
    const first = [await budget.chargeApi("k"), await budget.chargePlayground(), await budget.chargeArena()];
    expect(first).toEqual([true, true, true]);
    expect([await budget.chargeApi("k"), await budget.chargePlayground(), await budget.chargeArena()]).toEqual([false, false, false]);
    clock.now = Date.UTC(2026, 10, 3, 0, 0, 0, 0);
    expect([await budget.chargeApi("k"), await budget.chargePlayground(), await budget.chargeArena()]).toEqual([true, true, true]);
  });

  test("a store failure propagates, so the caller cannot treat it as budget left", async () => {
    const counter = { get: async () => 0, add: async () => { throw new Error("convex down"); } };
    const budget = makeBudget({ counter, clock: () => T0 });
    await expect(budget.chargeApi("k")).rejects.toThrow("convex down");
    await expect(budget.chargeArena()).rejects.toThrow("convex down");
  });
});

describe("SlidingWindow", () => {
  test("allows max hits per window, then returns whole seconds to wait", () => {
    const w = new SlidingWindow(60_000);
    for (let i = 0; i < 5; i++) expect(w.hit("a", 5, 1000 + i * 10)).toBe(0);
    expect(w.hit("a", 5, 1500)).toBe(60); // oldest hit at 1000 leaves at 61000: 59.5 s rounds up
    expect(w.hit("a", 5, 40_000)).toBe(21);
    expect(w.hit("a", 5, 61_001)).toBe(0); // the 1000 hit has left
  });

  test("a refused hit records nothing", () => {
    const w = new SlidingWindow(60_000);
    w.hit("a", 1, 0);
    for (let i = 0; i < 50; i++) w.hit("a", 1, 10_000);
    expect(w.hit("a", 1, 60_001)).toBe(0);
  });

  test("ids are independent", () => {
    const w = new SlidingWindow(60_000);
    expect(w.hit("a", 1, 0)).toBe(0);
    expect(w.hit("b", 1, 0)).toBe(0);
    expect(w.hit("a", 1, 1)).toBeGreaterThan(0);
  });

  test("ids nobody touches again are swept", () => {
    const w = new SlidingWindow(60_000);
    for (let i = 0; i < 1000; i++) w.hit(`ip-${i}`, 5, 0);
    expect(w.size).toBe(1000);
    w.hit("later", 5, 200_000);
    expect(w.size).toBe(1);
  });
});

describe("ipKey", () => {
  test("IPv4 is kept as is", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
  });
  test("IPv6 keys by the first 64 bits, whatever the spelling", () => {
    const k = ipKey("2001:db8:1:2::1");
    expect(k).toBe("2001:0db8:0001:0002::/64");
    for (const same of ["2001:DB8:1:2::ffff", "2001:db8:1:2:0:0:0:1", "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::"]) expect(ipKey(same)).toBe(k);
    for (const other of ["2001:db8:1:3::1", "2001:db8:2:2::1", "2002:db8:1:2::1", "3001:db8:1:2::1"]) expect(ipKey(other)).not.toBe(k);
  });
  test("compressed forms that cross the 64-bit line", () => {
    expect(ipKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipKey("::")).toBe("0000:0000:0000:0000::/64");
    expect(ipKey("1::")).toBe("0001:0000:0000:0000::/64");
    expect(ipKey("1:2:3:4:5:6:7:8")).toBe("0001:0002:0003:0004::/64");
    expect(ipKey("1:2::8")).toBe("0001:0002:0000:0000::/64");
    expect(ipKey("a:b:c::d:e")).toBe("000a:000b:000c:0000::/64");
  });
  test("an IPv4-mapped address is the IPv4 address, in any spelling", () => {
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(ipKey("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
  });
  test("an IPv6 address with an embedded IPv4 tail is read, and a zone id is dropped", () => {
    expect(ipKey("64:ff9b::192.0.2.33")).toBe("0064:ff9b:0000:0000::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });
});
