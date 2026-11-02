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
});
