import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { OUTCOMES, PAYOUT_OUTCOMES, STAGES } from "../../shared/attempt";
import { attemptLeaf, isoMs, leafOutcome, type LeafInput } from "../../shared/leaf";

const base: LeafInput = {
  id: "01JC2ZK6V3Q8N5R7T9W1X3Y5Z7",
  ts: "2026-11-02T12:34:56.789Z",
  tier: 3,
  account_hash: "a".repeat(64),
  message: "hello é\u{1F409} \"dragon\"",
  outcome: "refused",
  prompt_sha256: "b".repeat(64),
  model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  attestation_sha256: "c".repeat(64),
  codehash: "d".repeat(64),
};

describe("attemptLeaf", () => {
  test("is sha256 of the JSON array [id, ts, tier, account_hash, message, outcome, prompt_sha256, model_id, attestation_sha256, codehash]", () => {
    const r = base;
    const text = JSON.stringify([r.id, r.ts, r.tier, r.account_hash, r.message, r.outcome, r.prompt_sha256, r.model_id, r.attestation_sha256, r.codehash]);
    expect(attemptLeaf(base)).toBe(createHash("sha256").update(text).digest("hex"));
  });

  test("a fixed vector, so the encoding cannot drift unnoticed", () => {
    // computed once with node:crypto over the JSON text above, not with this module
    expect(attemptLeaf(base)).toBe("f65753543d0203b9888901fb0a506c7ed74b4f290a7470b0ddcf1736bd267c30");
    expect(attemptLeaf({ ...base, message: "hi" })).toBe("95b7c9f636992bdbba69d2ced2248c1e6fe420ba7a60c7522f172dac15f773c2");
  });

  test.each(["id", "ts", "tier", "account_hash", "message", "outcome", "prompt_sha256", "model_id", "attestation_sha256", "codehash"] as const)("changing %s changes the leaf", key => {
    const other: Record<string, unknown> = { id: "01JC2ZK6V3Q8N5R7T9W1X3Y5ZZ", ts: "2026-11-02T12:34:56.790Z", tier: 2, outcome: "blocked_a" };
    const changed = { ...base, [key]: other[key] ?? "different" } as LeafInput;
    expect(attemptLeaf(changed)).not.toBe(attemptLeaf(base));
  });

  test("fields outside the encoding do not change it", () => {
    const extra = { ...base, near_tx: "x", chain_txid: "y", reply: "z", stage: "done", payout_address: "p", hidden: true } as LeafInput;
    expect(attemptLeaf(extra)).toBe(attemptLeaf(base));
  });

  test("ts must be ISO-8601 UTC with milliseconds and a Z", () => {
    for (const ts of ["2026-11-02T12:34:56Z", "2026-11-02T12:34:56.789+00:00", "2026-11-02 12:34:56.789Z", "1762086896789", "2026-11-02T12:34:56.78Z", ""]) {
      expect(() => attemptLeaf({ ...base, ts })).toThrow("leaf ts");
    }
    expect(() => attemptLeaf({ ...base, ts: 1762086896789 as unknown as string })).toThrow("leaf ts");
  });

  test("isoMs writes the form the leaf accepts, whatever the millisecond value", () => {
    expect(isoMs(Date.UTC(2026, 10, 2, 12, 34, 56, 789))).toBe("2026-11-02T12:34:56.789Z");
    expect(isoMs(Date.UTC(2026, 10, 2, 12, 0, 0, 0))).toBe("2026-11-02T12:00:00.000Z");
    expect(() => attemptLeaf({ ...base, ts: isoMs(Date.UTC(2026, 10, 2, 12, 0, 0, 5)) })).not.toThrow();
  });
});

describe("the leaf is stable while a payout attempt moves through its outcomes", () => {
  test("every outcome a payout row can hold gives the leaf it had when it was inserted as releasing", () => {
    const first = attemptLeaf({ ...base, outcome: "releasing" });
    for (const outcome of PAYOUT_OUTCOMES) expect(attemptLeaf({ ...base, outcome })).toBe(first);
  });

  test("outcomes that are final at insert each give a different leaf", () => {
    const final = OUTCOMES.filter(o => !(PAYOUT_OUTCOMES as readonly string[]).includes(o));
    expect(final.sort()).toEqual(["blocked_a", "blocked_b", "refused", "tool_error", "won_race_lost"]);
    const leaves = new Set([...final, "releasing"].map(outcome => attemptLeaf({ ...base, outcome })));
    expect(leaves.size).toBe(final.length + 1);
  });

  test("a final-at-insert outcome cannot be turned into a payout outcome by a later edit", () => {
    expect(attemptLeaf({ ...base, outcome: "refused" })).not.toBe(attemptLeaf({ ...base, outcome: "drained" }));
    expect(leafOutcome("refused")).toBe("refused");
    expect(leafOutcome("drained")).toBe("releasing");
  });

  test("the shared lists have no duplicates", () => {
    expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length);
    expect(new Set(STAGES).size).toBe(STAGES.length);
    for (const o of PAYOUT_OUTCOMES) expect(OUTCOMES).toContain(o);
  });
});
