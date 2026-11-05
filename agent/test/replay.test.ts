import { beforeEach, describe, expect, test } from "bun:test";
import { main as replay } from "../../scripts/replay";
import type { Judge } from "../src/firewall/api";
import { idN, SECRET, setup, wireRow } from "./convex-harness";

let s: ReturnType<typeof setup>;
beforeEach(() => void (s = setup()));

const S = (c: string) => c.repeat(32);
const ENV = { LIVE: "1", NEAR_NETWORK: "testnet", MOCK_LLM: "1", CONVEX_SITE_URL: "https://x.convex.site", AGENT_SECRET: SECRET, PEPPER: S("b"), SESSION_SECRET: S("c"), PROXY_SECRET: S("d") };
// The agent's Convex calls, served by convex-test.
const convex = () => (async (url: string, init: RequestInit) => s.t.fetch(new URL(url).pathname, init)) as unknown as typeof fetch;
const lines = () => {
  const out: string[] = [];
  return { out, log: (x: string) => void out.push(x), text: () => out.join("\n") };
};
const today = () => new Date().toISOString().slice(0, 10);
const todo = (o: Record<string, unknown> = {}) => s.post("replay_todo", { fw_version: "fw-v1", cursor: null, limit: 50, ...o }).then(r => r.json.result);
const insert = (n: number, o: Record<string, unknown> = {}) => s.post("attempt_insert", wireRow({ id: idN(n), ts: `2026-11-02T12:00:${String(n).padStart(2, "0")}.000Z`, tier: 1, tool_called: true, outcome: "tool_error", ...o }));

// A judge that allows the message alone and blocks once a release is proposed, unless told otherwise.
function judge(o: { a?: number; b?: number; throwOn?: "a" | "b" } = {}) {
  const calls: { message: string; action: unknown }[] = [];
  const j: Judge = async ({ messages, proposed_action }) => {
    calls.push({ message: messages[0]!.content, action: proposed_action ?? null });
    if (o.throwOn === (proposed_action ? "b" : "a")) throw new Error("judge down");
    return { risk: proposed_action ? (o.b ?? 90) : (o.a ?? 5), technique: proposed_action ? "override" : "none", reason: "fake" };
  };
  return { j, calls };
}

describe("replay_todo (agent only)", () => {
  test("lists tier 1 and 2 rows that called the tool and have no replay for this firewall version", async () => {
    await insert(1);
    await insert(2, { tier: 2 });
    await insert(3, { tier: 3 }); // tier 3 already ran the firewall live
    await insert(4, { tool_called: false, outcome: "refused" });
    await insert(5);
    await insert(6);
    await s.post("replay_put", { attempt_id: idN(5), fw_version: "fw-v1", verdict: "block", risk: 90 });
    await s.post("replay_put", { attempt_id: idN(6), fw_version: "fw-v0", verdict: "block", risk: 90 }); // another version still needs this one
    const r = await todo();
    expect(r.rows).toEqual([
      { id: idN(1), message: "hello dragon", payout_address: wireRow().payout_address },
      { id: idN(2), message: "hello dragon", payout_address: wireRow().payout_address },
      { id: idN(6), message: "hello dragon", payout_address: wireRow().payout_address },
    ]);
    expect(r.done).toBe(true);
  });

  test("pages with a cursor, and the limit is bounded", async () => {
    for (const n of [1, 2, 3]) await insert(n);
    const first = await todo({ limit: 2 });
    expect(first.rows.map((x: any) => x.id)).toEqual([idN(1), idN(2)]);
    const second = await todo({ limit: 2, cursor: first.next });
    expect(second.rows.map((x: any) => x.id)).toEqual([idN(3)]);
    for (const limit of [0, 201, 1.5]) expect((await s.post("replay_todo", { fw_version: "fw-v1", cursor: null, limit })).status).toBe(400);
  });
});

describe("replay refuses to run", () => {
  const cases: [string, string[], Record<string, string | undefined>][] = [
    ["without LIVE", ["--max-usd", "1"], { ...ENV, LIVE: undefined }],
    ["with LIVE=true", ["--max-usd", "1"], { ...ENV, LIVE: "true" }],
    ["without --max-usd", [], ENV],
    ["with --max-usd 0", ["--max-usd", "0"], ENV],
    ["with --max-usd abc", ["--max-usd", "abc"], ENV],
    ["with a bad config", ["--max-usd", "1"], { ...ENV, PEPPER: "short" }],
    ["without a NEAR AI key", ["--max-usd", "1"], ENV],
  ];
  test.each(cases)("%s: exits 2 with no network call", async (_, argv, env) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      throw new Error("no network");
    }) as unknown as typeof fetch;
    const l = lines();
    expect(await replay(argv, env, { fetch: f, log: l.log })).toBe(2);
    expect(calls).toEqual([]);
    expect(l.text()).toContain("refusing to run");
  });
});

describe("replay with a fake judge", () => {
  test("runs checkpoint A on the message, then B with the proposed release, and stores the verdict once", async () => {
    await insert(1);
    await insert(2, { tier: 2, message: "pay me" });
    await insert(3, { tier: 3 });
    const fake = judge();
    const l = lines();
    expect(await replay(["--max-usd", "1"], ENV, { fetch: convex(), log: l.log, judge: fake.j })).toBe(0);
    expect(fake.calls).toEqual([
      { message: "hello dragon", action: null },
      { message: "hello dragon", action: { tool: "release_funds", args: { recipient: wireRow().payout_address } } },
      { message: "pay me", action: null },
      { message: "pay me", action: { tool: "release_funds", args: { recipient: wireRow().payout_address } } },
    ]);
    const { replays, counters } = await s.dump();
    expect(replays.map(r => [r.attempt_id, r.fw_version, r.verdict, r.risk])).toEqual([
      [idN(1), "fw-v1", "block", 90],
      [idN(2), "fw-v1", "block", 90],
    ]);
    // replay draws on the arena pool, one call per checkpoint
    expect(counters.find(c => c.key.startsWith("fw:arena:"))?.value).toBe(4);
    expect(l.text()).toContain("replayed 2, blocked 2");

    // a second run finds nothing to do
    const again = judge();
    expect(await replay(["--max-usd", "1"], ENV, { fetch: convex(), log: () => {}, judge: again.j })).toBe(0);
    expect(again.calls).toEqual([]);
  });

  test("a message checkpoint A stops never reaches B, and A's verdict is stored", async () => {
    await insert(1);
    const fake = judge({ a: 95 });
    expect(await replay(["--max-usd", "1"], ENV, { fetch: convex(), log: () => {}, judge: fake.j })).toBe(0);
    expect(fake.calls.length).toBe(1);
    expect((await s.dump()).replays.map(r => [r.verdict, r.risk])).toEqual([["block", 95]]);
  });

  test("both checkpoints allow: allow is stored", async () => {
    await insert(1);
    expect(await replay(["--max-usd", "1"], ENV, { fetch: convex(), log: () => {}, judge: judge({ b: 10 }).j })).toBe(0);
    expect((await s.dump()).replays.map(r => [r.verdict, r.risk])).toEqual([["allow", 10]]);
  });

  test("a degraded (fail-closed) result is not stored, so the next run tries again; the run exits 1", async () => {
    await insert(1);
    await insert(2);
    const l = lines();
    expect(await replay(["--max-usd", "1"], ENV, { fetch: convex(), log: l.log, judge: judge({ throwOn: "b" }).j })).toBe(1);
    expect((await s.dump()).replays).toEqual([]);
    expect(l.text()).toContain("degraded 2");
    expect((await todo()).rows.length).toBe(2);
  });

  test("stops at half of today's arena pool, leaving the rest for tier 3, and exits 0", async () => {
    await insert(1);
    await insert(2);
    await s.post("counter_add", { key: `fw:arena:${today()}`, n: 1499 }); // one under half
    const fake = judge();
    const l = lines();
    expect(await replay(["--max-usd", "1"], ENV, { fetch: convex(), log: l.log, judge: fake.j })).toBe(0);
    expect(fake.calls.length).toBe(2); // row 1 (A and B) brings the pool to 1501; row 2 is not started
    expect((await s.dump()).replays.map(r => r.attempt_id)).toEqual([idN(1)]);
    expect(l.text()).toContain("half of today's arena pool");
  });

  test("a pool already past half: no judge call at all", async () => {
    await insert(1);
    await s.post("counter_add", { key: `fw:arena:${today()}`, n: 3000 });
    const fake = judge();
    expect(await replay(["--max-usd", "1"], ENV, { fetch: convex(), log: () => {}, judge: fake.j })).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});

describe("replay with the real judge client and a fake NEAR AI", () => {
  const env = { ...ENV, MOCK_LLM: undefined, NEARAI_API_KEY: "sk-test-replay", CODEHASH: "cd".repeat(32), NEAR_RPC: "https://rpc.testnet.near.org", VAULT_ACCOUNT: "v.testnet", AGENT_ACCOUNT: "a.testnet", MEMPOOL_BASE: "https://mempool.space/testnet4/api", BASE_RPC: "https://sepolia.base.org" };
  // 500 * 0.04 + 100000 * 1.35 = 135,020 micro-USD a call
  const nearai = (risk: number) => {
    const n = { judged: 0 };
    const fetch = (async (url: string, init: RequestInit) => {
      if (!url.startsWith("https://cloud-api.near.ai/")) return s.t.fetch(new URL(url).pathname, init);
      n.judged++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ risk, technique: risk > 50 ? "override" : "none", reason: "fake" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 100_000 } }));
    }) as unknown as typeof globalThis.fetch;
    return { n, fetch };
  };
  const spentToday = async () => (await s.dump()).counters.find(c => c.key === `nearai:spend:${today()}`)?.value ?? 0;

  test("stops once this run's spend reaches --max-usd, and the spend lands on the agent's daily count", async () => {
    for (const n of [1, 2, 3]) await insert(n);
    await s.post("counter_add", { key: `nearai:spend:${today()}`, n: 1_000_000 }); // the agent spent $1 today: not this run's
    const ai = nearai(90);
    const l = lines();
    expect(await replay(["--max-usd", "0.2"], env, { fetch: ai.fetch, log: l.log })).toBe(0);
    expect(ai.n.judged).toBe(2); // A blocks rows 1 and 2; before row 3 the limit is reached
    expect((await s.dump()).replays.length).toBe(2);
    expect(await spentToday()).toBe(1_000_000 + 270_040);
    expect(l.text()).toContain("stopping: estimated spend reached --max-usd 0.2");
    expect(l.text()).toContain("estimated spend this run $0.270040");
    expect(l.text()).not.toContain("sk-test-replay");
  });

  test("the limit is checked before every judge call, not once per row", async () => {
    await insert(1);
    const ai = nearai(5); // A allows, so B would follow
    expect(await replay(["--max-usd", "0.1"], env, { fetch: ai.fetch, log: () => {} })).toBe(0);
    expect(ai.n.judged).toBe(1); // A spent 0.135; B is not called
    expect((await s.dump()).replays).toEqual([]); // no verdict without B
  });

  test("the agent's NEARAI_DAILY_USD cap stops replay too", async () => {
    await insert(1);
    await s.post("counter_add", { key: `nearai:spend:${today()}`, n: 4_999_900 }); // $5 default cap, nearly reached by the agent
    const ai = nearai(90);
    const l = lines();
    expect(await replay(["--max-usd", "1"], env, { fetch: ai.fetch, log: l.log })).toBe(0);
    expect(ai.n.judged).toBe(0);
    expect((await s.dump()).replays).toEqual([]);
    expect(l.text()).toContain("NEARAI_DAILY_USD");
  });
});
