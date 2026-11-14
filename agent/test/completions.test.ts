import { describe, expect, test } from "bun:test";
import { responseVerified, trackCompletion, withCompletions } from "../src/completions";

const info = { id: "c1", model: "m", requestHash: "a", responseHash: "b" };

describe("completion tracking per attempt", () => {
  test("false with no calls or outside an attempt", async () => {
    expect(await responseVerified()).toBe(false);
    expect(await withCompletions(() => responseVerified())).toBe(false);
  });
  test("true only when every call of this attempt verified", async () => {
    const yes = trackCompletion(async () => true);
    const no = trackCompletion(async c => c.id === "c1");
    expect(await withCompletions(async () => (yes(info), no(info), responseVerified()))).toBe(true);
    expect(await withCompletions(async () => (yes(info), no({ ...info, id: "c2" }), responseVerified()))).toBe(false);
  });
  test("a throwing or slow check is false, and a slow one does not hold the attempt past the wait", async () => {
    const boom = trackCompletion(async () => { throw new Error("x"); });
    expect(await withCompletions(async () => (boom(info), responseVerified()))).toBe(false);
    const slow = trackCompletion(() => new Promise<boolean>(r => setTimeout(() => r(true), 500)));
    const t0 = performance.now();
    expect(await withCompletions(async () => (slow(info), responseVerified(20)))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  test("attempts do not see each other's calls", async () => {
    const yes = trackCompletion(async () => true);
    const a = withCompletions(async () => (yes(info), await Bun.sleep(5), responseVerified()));
    const b = withCompletions(async () => (await Bun.sleep(1), responseVerified()));
    expect([await a, await b]).toEqual([true, false]);
  });
  test("a check never delays the call that triggered it", () => {
    const t = trackCompletion(() => new Promise<boolean>(() => {}));
    const t0 = performance.now();
    withCompletions(async () => t(info));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
