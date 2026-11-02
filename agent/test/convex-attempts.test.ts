import { beforeEach, describe, expect, test } from "bun:test";
import { api, FW, H, idN, setup, wireRow } from "./convex-harness";

let s: ReturnType<typeof setup>;
beforeEach(() => void (s = setup()));

const insert = (o: Record<string, unknown> = {}) => s.post("attempt_insert", wireRow(o));
const docs = async () => (await s.dump()).attempts;
const counter = async (key: string) => (await s.t.query(api.counters.get, { key })) as number;

describe("insert", () => {
  test("stores the row as sent, not hidden, and the export returns every column", async () => {
    const r = await insert();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ result: null });
    const [d] = await docs();
    expect(d).toMatchObject({ ...wireRow(), hidden: false });
    const page = await s.post("attempts_export", { since: "", cursor: null, limit: 10 });
    expect(page.json.result.rows).toEqual([{ ...wireRow(), hidden: false }]);
    expect(Object.keys(page.json.result.rows[0])).not.toContain("_id");
  });

  test("a row with no model output (blocked_a) is stored with llm_output null", async () => {
    expect((await insert({ outcome: "blocked_a", llm_output: null, fw_a: { ...FW, verdict: "block" } })).status).toBe(200);
    expect((await docs())[0]!.llm_output).toBeNull();
  });

  test.each([
    ["message over 2000 characters", { message: "x".repeat(2001) }],
    ["id that is not a ULID", { id: "not-a-ulid" }],
    ["lowercase ULID", { id: "01jc2zk6v3q8n5r7t9w1x3y5z7" }],
    ["ts without milliseconds", { ts: "2026-11-02T12:34:56Z" }],
    ["ts as a number", { ts: 1762086896789 }],
    ["a raw NEAR account where account_hash goes", { account_hash: "alice.near" }],
    ["a raw IP where ip_hash goes", { ip_hash: "203.0.113.9" }],
    ["an upper-case hash", { account_hash: "A".repeat(64) }],
    ["a short leaf", { leaf: "abc" }],
    ["empty consent_version", { consent_version: "" }],
    ["empty payout_address", { payout_address: "" }],
    ["a payout_address over 128 characters", { payout_address: "t".repeat(129) }],
    ["a reply over 8000 characters", { reply: "x".repeat(8001) }],
    ["tier 4", { tier: 4 }],
    ["tier as a string", { tier: "3" }],
    ["an unknown outcome", { outcome: "won" }],
    ["an unknown stage", { stage: "lunch" }],
    ["an unknown field", { hidden: true }],
    ["an unknown firewall field", { fw_a: { ...FW, extra: 1 } }],
    ["a bad firewall verdict", { fw_a: { ...FW, verdict: "maybe" } }],
    ["llm_output as an object instead of text", { llm_output: { content: "x" } }],
    ["tool_called as a string", { tool_called: "yes" }],
  ])("%s is a 400 and writes nothing", async (_, o) => {
    const before = JSON.stringify(await s.dump());
    const r = await insert(o);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("bad_request");
    expect(JSON.stringify(await s.dump())).toBe(before);
  });

  test.each(["drained", "signed_pending_broadcast", "release_failed", "broadcast_failed_terminal"])("a row cannot be inserted as %s: payouts reach it only from releasing", async outcome => {
    expect((await insert({ outcome })).status).toBe(400);
    expect(await docs()).toEqual([]);
  });

  test.each(["refused", "blocked_a", "blocked_b", "tool_error", "releasing", "won_race_lost"])("%s can be inserted", async outcome => {
    expect((await insert({ outcome })).status).toBe(200);
  });

  test("the same id twice is a 409 and the first row stands", async () => {
    await insert({ message: "first" });
    const r = await insert({ message: "second", tier: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("conflict");
    const all = await docs();
    expect(all.length).toBe(1);
    expect(all[0]!.message).toBe("first");
    expect(await counter("attempts:tier:1")).toBe(0);
  });

  test("attempts per tier are counted in the same transaction as the row", async () => {
    await insert({ id: idN(1), tier: 1 });
    await insert({ id: idN(2), tier: 1 });
    await insert({ id: idN(3), tier: 3 });
    expect(await counter("attempts:tier:1")).toBe(2);
    expect(await counter("attempts:tier:2")).toBe(0);
    expect(await counter("attempts:tier:3")).toBe(1);
    expect((await s.dump()).attempts.length).toBe(3);
  });

  test("near misses (blocked_b) are counted per tier, nothing else is", async () => {
    await insert({ id: idN(1), outcome: "blocked_b", fw_b: { ...FW, verdict: "block" }, tool_called: true });
    await insert({ id: idN(2), outcome: "blocked_a" });
    await insert({ id: idN(3), outcome: "refused" });
    expect(await counter("nearmiss:tier:3")).toBe(1);
    expect(await counter("nearmiss:tier:1")).toBe(0);
  });
});

describe("finish", () => {
  const releasing = (o: Record<string, unknown> = {}) => insert({ outcome: "releasing", reply: "model text", stage: "signing", tool_called: true, ...o });
  const finish = (o: Record<string, unknown>) => s.post("attempt_finish", { id: wireRow().id, ...o });

  test("a releasing row becomes drained with its transactions and reply, and moves to done", async () => {
    await releasing();
    const before = (await docs())[0]!;
    const r = await finish({ outcome: "drained", reply: "You won.", near_tx: "ntx", chain_txid: "ctx" });
    expect(r.status).toBe(200);
    const after = (await docs())[0]!;
    expect(after).toMatchObject({ outcome: "drained", reply: "You won.", near_tx: "ntx", chain_txid: "ctx", stage: "done" });
    const { outcome, reply, near_tx, chain_txid, stage, ...rest } = after;
    const { outcome: _o, reply: _r, near_tx: _n, chain_txid: _c, stage: _s, ...restBefore } = before;
    expect(rest).toEqual(restBefore); // leaf, ts, message, hashes and the rest are untouched
  });

  test("fields that are not sent stay as they were", async () => {
    await releasing({ near_tx: "earlier" });
    await finish({ outcome: "signed_pending_broadcast" });
    expect(await docs()).toMatchObject([{ outcome: "signed_pending_broadcast", reply: "model text", near_tx: "earlier", chain_txid: null, stage: "done" }]);
  });

  test.each([
    ["releasing", "drained", true],
    ["releasing", "signed_pending_broadcast", true],
    ["releasing", "release_failed", true],
    ["releasing", "broadcast_failed_terminal", false],
    ["releasing", "refused", false],
    ["releasing", "releasing", false],
    ["releasing", "won_race_lost", false],
    ["signed_pending_broadcast", "drained", true],
    ["signed_pending_broadcast", "broadcast_failed_terminal", true],
    ["signed_pending_broadcast", "release_failed", false],
    ["signed_pending_broadcast", "releasing", false],
    ["drained", "release_failed", false],
    ["drained", "drained", false],
    ["drained", "signed_pending_broadcast", false],
    ["release_failed", "drained", false],
    ["broadcast_failed_terminal", "drained", false],
    ["refused", "drained", false],
    ["blocked_b", "drained", false],
    ["tool_error", "drained", false],
    ["won_race_lost", "drained", false],
  ] as const)("%s to %s is %s", async (from, to, ok) => {
    // a row can only be inserted as one of the insert outcomes; reach the others through the store
    await s.t.run(async ctx => void (await ctx.db.insert("attempts", { ...wireRow({ outcome: from }), hidden: false } as never)));
    const r = await finish({ outcome: to });
    expect(r.status).toBe(ok ? 200 : 409);
    if (!ok) expect(r.json.error).toBe("bad_transition");
    expect((await docs())[0]!.outcome).toBe(ok ? to : from);
  });

  test("an unknown id is a 404", async () => {
    const r = await finish({ outcome: "drained" });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("not_found");
  });

  test.each([["message", "x"], ["leaf", H("f")], ["ts", "2026-11-03T00:00:00.000Z"], ["hidden", true], ["account_hash", H("f")], ["stage", "reading"], ["tier", 1]])("%s cannot be changed by a finish", async (key, value) => {
    await releasing();
    const before = JSON.stringify(await docs());
    expect((await finish({ outcome: "drained", [key]: value })).status).toBe(400);
    expect(JSON.stringify(await docs())).toBe(before);
  });
});

describe("setStage", () => {
  const stage = (id: string, st: string) => s.post("attempt_stage", { id, stage: st });

  test("moves forward and reports whether it changed anything", async () => {
    await insert({ stage: "signing", outcome: "releasing" });
    const id = wireRow().id;
    expect((await stage(id, "broadcasting")).json.result).toBe(true);
    expect((await docs())[0]!.stage).toBe("broadcasting");
    expect((await stage(id, "done")).json.result).toBe(true);
    expect((await docs())[0]!.stage).toBe("done");
  });

  test("never moves backward or sideways, so a late update cannot undo done", async () => {
    await insert({ stage: "done" });
    const id = wireRow().id;
    for (const st of ["reading", "firewall_a", "thinking", "firewall_b", "signing", "broadcasting", "done"]) {
      expect((await stage(id, st)).json.result).toBe(false);
    }
    expect((await docs())[0]!.stage).toBe("done");
  });

  test("a row that does not exist yet is not an error", async () => {
    const r = await stage(idN(9), "thinking");
    expect(r.status).toBe(200);
    expect(r.json.result).toBe(false);
  });

  test("an unknown stage, or a missing id, is a 400", async () => {
    expect((await stage(idN(9), "lunch")).status).toBe(400);
    expect((await s.post("attempt_stage", { stage: "done" })).status).toBe(400);
  });
});

describe("report", () => {
  const report = (attempt_id: string, account_hash: string) => s.post("attempt_report", { attempt_id, account_hash });

  test("three reports from three accounts hide a row; the row stays in the export", async () => {
    await insert();
    const id = wireRow().id;
    expect((await report(id, H("1"))).json.result).toEqual({ hidden: false });
    expect((await report(id, H("2"))).json.result).toEqual({ hidden: false });
    expect((await report(id, H("3"))).json.result).toEqual({ hidden: true });
    expect((await docs())[0]!.hidden).toBe(true);
    const page = await s.post("attempts_export", { since: "", cursor: null, limit: 10 });
    expect(page.json.result.rows.map((r: any) => r.id)).toEqual([id]);
    expect(page.json.result.rows[0].hidden).toBe(true);
  });

  test("the same account reporting again counts once", async () => {
    await insert();
    const id = wireRow().id;
    for (let i = 0; i < 5; i++) expect((await report(id, H("1"))).json.result).toEqual({ hidden: false });
    expect((await s.dump()).reports.length).toBe(1);
    await report(id, H("2"));
    expect((await docs())[0]!.hidden).toBe(false);
  });

  test("reports for one attempt do not count towards another", async () => {
    await insert({ id: idN(1) });
    await insert({ id: idN(2) });
    await report(idN(1), H("1"));
    await report(idN(1), H("2"));
    await report(idN(2), H("3"));
    expect((await docs()).map(d => d.hidden)).toEqual([false, false]);
  });

  test("an unknown attempt is a 404 and a raw account is a 400", async () => {
    expect((await report(idN(9), H("1"))).status).toBe(404);
    await insert();
    expect((await report(wireRow().id, "alice.near")).status).toBe(400);
    expect((await s.dump()).reports).toEqual([]);
  });
});

describe("export", () => {
  test("pages in ts order from `since`, and the cursor continues", async () => {
    for (const n of [3, 1, 2, 5, 4]) await insert({ id: idN(n), ts: `2026-11-02T12:00:0${n}.000Z` });
    const first = await s.post("attempts_export", { since: "2026-11-02T12:00:02.000Z", cursor: null, limit: 2 });
    expect(first.json.result.rows.map((r: any) => r.id)).toEqual([idN(2), idN(3)]);
    expect(first.json.result.done).toBe(false);
    const second = await s.post("attempts_export", { since: "2026-11-02T12:00:02.000Z", cursor: first.json.result.next, limit: 2 });
    expect(second.json.result.rows.map((r: any) => r.id)).toEqual([idN(4), idN(5)]);
    const third = await s.post("attempts_export", { since: "2026-11-02T12:00:02.000Z", cursor: second.json.result.next, limit: 2 });
    expect(third.json.result.rows).toEqual([]);
    expect(third.json.result.done).toBe(true);
  });

  test("limit is bounded", async () => {
    expect((await s.post("attempts_export", { since: "", cursor: null, limit: 0 })).status).toBe(400);
    expect((await s.post("attempts_export", { since: "", cursor: null, limit: 1001 })).status).toBe(400);
  });
});
