import { describe, expect, test } from "bun:test";
import { guardedCall, type Verdict } from "../../shared/guarded-call";

const v = (verdict: Verdict["verdict"]): Verdict => ({ verdict, risk: 50, reason: "r" });
// Counts calls and records their order.
const probe = (verdict: Verdict["verdict"] | Error, human = true) => {
  const log: string[] = [];
  return {
    log,
    o: {
      check: async () => {
        log.push("check");
        if (verdict instanceof Error) throw verdict;
        return v(verdict);
      },
      act: async () => (log.push("act"), "done"),
      askHuman: async (_: Verdict) => (log.push("ask"), human),
    },
  };
};

describe("guardedCall", () => {
  test("block never calls act or askHuman", async () => {
    const p = probe("block");
    expect(await guardedCall(p.o)).toEqual({ done: false, verdict: v("block") });
    expect(p.log).toEqual(["check"]);
  });

  test("escalate plus human no never calls act", async () => {
    const p = probe("escalate", false);
    expect(await guardedCall(p.o)).toEqual({ done: false, verdict: v("escalate") });
    expect(p.log).toEqual(["check", "ask"]);
  });

  test("escalate plus human yes calls act once", async () => {
    const p = probe("escalate", true);
    expect(await guardedCall(p.o)).toEqual({ done: true, result: "done" });
    expect(p.log).toEqual(["check", "ask", "act"]);
  });

  test("allow never asks", async () => {
    const p = probe("allow");
    expect(await guardedCall(p.o)).toEqual({ done: true, result: "done" });
    expect(p.log).toEqual(["check", "act"]);
  });

  test("check throwing propagates and never calls act (fail closed)", async () => {
    const p = probe(new Error("firewall down"));
    await expect(guardedCall(p.o)).rejects.toThrow("firewall down");
    expect(p.log).toEqual(["check"]);
  });

  test("askHuman throwing propagates and never calls act", async () => {
    const p = probe("escalate");
    p.o.askHuman = async () => {
      throw new Error("no human");
    };
    await expect(guardedCall(p.o)).rejects.toThrow("no human");
    expect(p.log).toEqual(["check"]);
  });

  test("the verdict is passed to askHuman", async () => {
    let seen: Verdict | undefined;
    await guardedCall({ check: async () => v("escalate"), act: async () => 1, askHuman: async x => ((seen = x), false) });
    expect(seen).toEqual(v("escalate"));
  });

  // check() comes from a network response, so its shape is not guaranteed. Only an explicit allow acts.
  test.each([
    ["an empty object", {}],
    ["BLOCK in capitals", { verdict: "BLOCK", risk: 99, reason: "r" }],
    ["ALLOW in capitals", { verdict: "ALLOW", risk: 0, reason: "r" }],
    ["deny", { verdict: "deny", risk: 99, reason: "r" }],
    ["null", { verdict: null, risk: 0, reason: "r" }],
    ["a number", { verdict: 1, risk: 0, reason: "r" }],
    ["an object", { verdict: { verdict: "allow" }, risk: 0, reason: "r" }],
    ["an inherited-looking name", { verdict: "constructor", risk: 0, reason: "r" }],
    ["allow with trailing space", { verdict: "allow ", risk: 0, reason: "r" }],
  ])("an unknown verdict (%s) never acts and never asks", async (_, v) => {
    const log: string[] = [];
    const r = await guardedCall({
      check: async () => v as unknown as Verdict,
      act: async () => (log.push("act"), "done"),
      askHuman: async () => (log.push("ask"), true),
    });
    expect(r).toEqual({ done: false, verdict: v as unknown as Verdict });
    expect(log).toEqual([]);
  });

  test.each([["undefined", undefined], ["null", null], ["a string", "allow"]])("a check that returns %s never acts", async (_, v) => {
    const log: string[] = [];
    const p = guardedCall({ check: async () => v as unknown as Verdict, act: async () => (log.push("act"), 1), askHuman: async () => (log.push("ask"), true) });
    if (typeof v === "string") expect(await p).toEqual({ done: false, verdict: v as never });
    else await expect(p).rejects.toThrow();
    expect(log).toEqual([]);
  });
});
