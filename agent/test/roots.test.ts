import { expect, test } from "bun:test";
import { startRootsPoster } from "../src/roots";
import { epochDay } from "../../shared/merkle";

const T0 = Date.parse("2026-11-03T00:00:00.000Z");
const ROOTS: [number, string][] = [[1, "ab".repeat(32)]];

// Timers run by hand: `fire` runs the one pending timer and waits for its run to finish.
function harness(o: { onChain?: [number, string][]; build?: (date: string) => Promise<any>; postFails?: number; start?: number } = {}) {
  let now = o.start ?? T0;
  let pending: { fn: () => void; ms: number } | null = null;
  const posted: { day: number; roots: [number, string][] }[] = [];
  const built: string[] = [];
  const events: [string, Record<string, unknown>][] = [];
  const alerts: [string, Record<string, unknown>][] = [];
  let onChain = o.onChain ?? [];
  let fails = o.postFails ?? 0;
  const stop = startRootsPoster({
    build: o.build ?? (async date => (built.push(date), { ok: true, out: [], roots: ROOTS })),
    vault: {
      getRoots: async () => onChain,
      logAttemptRoots: async (day, roots) => {
        posted.push({ day, roots });
        if (fails-- > 0) throw new Error("near rpc broadcast_tx_async: http 503");
        onChain = roots;
      },
    },
    log: (e, d) => void events.push([e, d]),
    alert: (k, d) => void alerts.push([k, d]),
    clock: () => now,
    setTimer: (fn, ms) => (pending = { fn, ms }),
    clearTimer: () => void (pending = null),
    retryMs: 3_600_000,
  });
  const fire = async () => {
    const p = pending!;
    pending = null;
    now += p.ms;
    p.fn();
    for (let i = 0; i < 50 && !pending; i++) await Bun.sleep(0);
    return p.ms;
  };
  return { stop, fire, posted, built, events, alerts, next: () => pending?.ms ?? null };
}

test("first run at 00:10 UTC posts yesterday's roots once, then waits a day", async () => {
  const h = harness();
  expect(await h.fire()).toBe(10 * 60_000);
  expect(h.built).toEqual(["2026-11-02"]);
  expect(h.posted).toEqual([{ day: epochDay("2026-11-02"), roots: ROOTS }]);
  expect(h.events).toEqual([["roots_posted", { date: "2026-11-02", hours: 1, already: false }]]);
  expect(h.next()).toBe(86_400_000);
  h.stop();
  expect(h.next()).toBeNull();
});
test("roots already on-chain and equal are done; different ones alert and are not retried", async () => {
  const same = harness({ onChain: ROOTS });
  await same.fire();
  expect(same.posted).toEqual([]);
  expect(same.events[0]).toEqual(["roots_posted", { date: "2026-11-02", hours: 1, already: true }]);
  expect(same.alerts).toEqual([]);
  same.stop();
  const other = harness({ onChain: [[1, "cd".repeat(32)]] });
  await other.fire();
  expect(other.posted).toEqual([]);
  expect(other.alerts).toEqual([["roots_mismatch", { date: "2026-11-02" }]]);
  expect(other.next()).toBe(86_400_000);
  other.stop();
});
test("a failed post alerts and retries the same day in an hour", async () => {
  const h = harness({ postFails: 1 });
  await h.fire();
  expect(h.alerts).toEqual([["roots_post_failed", { date: "2026-11-02", error: "near rpc broadcast_tx_async: http 503" }]]);
  expect(h.next()).toBe(3_600_000);
  await h.fire();
  expect(h.posted.length).toBe(2);
  expect(h.events.at(-1)).toEqual(["roots_posted", { date: "2026-11-02", hours: 1, already: false }]);
  expect(h.next()).toBe(86_400_000 - 3_600_000); // back on 00:10
  h.stop();
});
test("a day with no attempts posts nothing; a failed build retries", async () => {
  const empty = harness({ build: async () => ({ ok: true, out: [], roots: [] }) });
  await empty.fire();
  expect(empty.posted).toEqual([]);
  expect(empty.alerts).toEqual([]);
  empty.stop();
  const bad = harness({ build: async () => ({ ok: false, reason: "leaf mismatch: attempt X does not hash to its stored leaf" }) });
  await bad.fire();
  expect(bad.alerts[0]![0]).toBe("roots_post_failed");
  expect(bad.next()).toBe(3_600_000);
  bad.stop();
});

test("a restart after 00:10 posts yesterday at once instead of skipping it", async () => {
  const h = harness({ start: T0 + 5 * 3_600_000 });
  expect(await h.fire()).toBe(0);
  expect(h.built).toEqual(["2026-11-02"]);
  expect(h.next()).toBe(86_400_000 - 5 * 3_600_000 + 10 * 60_000);
});
