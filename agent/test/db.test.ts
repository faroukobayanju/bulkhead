import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { attemptLeaf } from "../../shared/leaf";
import { memoryCounter } from "../src/counter";
import { DbError, makeDb, type AttemptRow } from "../src/db";
import { makeBudget } from "../src/firewall/budget";
import { makeNearAI } from "../src/nearai";
import { api, H, idN, SECRET, setup } from "./convex-harness";

const PEPPER = "test-pepper-0123456789abcdef-0123456789";
const SITE = "https://agent-test.convex.site";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ACCOUNT = "alice-SENTINEL.near";
const IP = "203.0.113.77";
const FW = { verdict: "allow", risk: 10, technique: "none", reason: "ok", firewall_version: "fw-v1", codehash: "local", latency_ms: 5, degraded: false } as const;

const row = (o: Partial<AttemptRow> = {}): AttemptRow => ({
  id: idN(1),
  ts: "2026-11-02T12:34:56.789Z",
  tier: 3,
  account: ACCOUNT,
  ip: IP,
  message: "hello dragon",
  normalized: "hello dragon",
  fw_a: FW,
  llm_output: { role: "assistant", content: "No.", tool_calls: [{ function: { name: "release_funds", arguments: '{"recipient":"x"}' } }] },
  tool_called: true,
  fw_b: null,
  outcome: "refused",
  technique: "none",
  prompt_sha256: H("c"),
  model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  attestation_sha256: H("d"),
  codehash: "local",
  near_tx: null,
  chain_txid: null,
  payout_address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  consent_version: "consent-v1",
  reply: "No.",
  stage: "done",
  ...o,
});

// A fake Convex site: records every request, answers with `reply`.
function fake(reply: (op: string, body: any, n: number) => Response | Promise<Response> = () => json({ result: null })) {
  const calls: { url: string; op: string; init: RequestInit; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body as string);
    const op = new URL(url).pathname.replace("/agent/", "");
    calls.push({ url, op, init, body });
    return reply(op, body, calls.length);
  }) as unknown as typeof globalThis.fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const make = (f: typeof globalThis.fetch, o: Record<string, unknown> = {}) => makeDb({ fetch: f, siteUrl: SITE, secret: SECRET, pepper: PEPPER, ...o });

describe("construction", () => {
  test("refuses to start without a PEPPER, with an empty one, or with a short one", () => {
    for (const pepper of [undefined, "", "short", "x".repeat(15)]) {
      expect(() => makeDb({ fetch: fake().f, siteUrl: SITE, secret: SECRET, pepper: pepper as never })).toThrow("PEPPER");
    }
    expect(() => make(fake().f, { pepper: "x".repeat(16) })).not.toThrow();
  });

  test("refuses to start without the agent secret or the site URL", () => {
    expect(() => make(fake().f, { secret: "" })).toThrow("AGENT_SECRET");
    expect(() => make(fake().f, { secret: undefined })).toThrow("AGENT_SECRET");
    expect(() => make(fake().f, { siteUrl: "" })).toThrow("CONVEX_SITE_URL");
    expect(() => make(fake().f, { siteUrl: "not a url" })).toThrow("CONVEX_SITE_URL");
  });

  test("the secret never travels over plain http, except to the local dev backend", () => {
    expect(() => make(fake().f, { siteUrl: "http://example.com" })).toThrow("https");
    expect(() => make(fake().f, { siteUrl: "http://agent.convex.site" })).toThrow("https");
    for (const ok of ["http://127.0.0.1:3211", "http://localhost:3211", "http://[::1]:3211", "https://x.convex.site", "https://x.convex.site/"]) expect(() => make(fake().f, { siteUrl: ok })).not.toThrow();
  });
});

describe("requests", () => {
  test("POST /agent/<op> with the secret in x-agent-secret and nowhere else", async () => {
    const t = fake();
    const db = make(t.f);
    await db.ping();
    await db.setStage(idN(1), "thinking");
    expect(t.calls.map(c => c.op)).toEqual(["health", "attempt_stage"]);
    for (const c of t.calls) {
      expect(c.url.startsWith(`${SITE}/agent/`)).toBe(true);
      expect(c.init.method).toBe("POST");
      expect((c.init.headers as Record<string, string>)["x-agent-secret"]).toBe(SECRET);
      expect((c.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect(JSON.stringify(c.body ?? "")).not.toContain(SECRET);
      expect(c.url).not.toContain(SECRET);
    }
  });

  test("a trailing slash on the site URL is not doubled", async () => {
    const t = fake();
    await make(t.f, { siteUrl: `${SITE}/` }).ping();
    expect(t.calls[0]!.url).toBe(`${SITE}/agent/health`);
  });

  test("a non-2xx answer is a DbError with the status and the error code, and nothing from the request", async () => {
    const t = fake(() => json({ error: "conflict", detail: "id exists" }, 409));
    const err = await make(t.f).insertAttempt(row()).catch(e => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({ op: "attempt_insert", status: 409, code: "conflict" });
    expect(err.message).toBe("db attempt_insert failed: 409 conflict");
    for (const secret of [SECRET, PEPPER, ACCOUNT, IP, "hello dragon"]) expect(err.message).not.toContain(secret);
  });

  test("a 401, a 500 and a body that is not JSON all fail", async () => {
    for (const reply of [() => json({ error: "unauthorized" }, 401), () => json({ error: "internal" }, 500), () => new Response("<html>", { status: 502 }), () => new Response("not json", { status: 200 })]) {
      await expect(make(fake(reply).f).ping()).rejects.toBeInstanceOf(DbError);
    }
  });

  test("a network failure is a DbError that does not carry the failure's text", async () => {
    const f = (async () => {
      throw new Error(`connect failed for ${SECRET}`);
    }) as unknown as typeof globalThis.fetch;
    const err = await make(f).ping().catch(e => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe("network");
    expect(err.message).not.toContain(SECRET);
  });

  test("a call that takes longer than timeoutMs is aborted", async () => {
    const f = ((_: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof globalThis.fetch;
    const err = await make(f, { timeoutMs: 20 }).ping().catch(e => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe("timeout");
  });

  test("ping resolves on 200 and rejects when Convex is down", async () => {
    await expect(make(fake(() => json({ result: true })).f).ping()).resolves.toBeUndefined();
    await expect(make(fake(() => json({}, 503)).f).ping()).rejects.toBeInstanceOf(DbError);
  });
});

describe("insertAttempt", () => {
  const sent = async (r: AttemptRow) => {
    const t = fake();
    await make(t.f).insertAttempt(r);
    return t.calls[0]!.body;
  };

  test("hashes the account and the IP with the pepper, and sends no raw value", async () => {
    const t = fake();
    await make(t.f).insertAttempt(row());
    const { op, body, init } = t.calls[0]!;
    expect(op).toBe("attempt_insert");
    expect(body.account_hash).toBe(sha(ACCOUNT + PEPPER));
    expect(body.ip_hash).toBe(sha(IP + PEPPER));
    expect(body.account_hash).not.toBe(body.ip_hash);
    expect("account" in body || "ip" in body).toBe(false);
    const all = init.body as string;
    for (const raw of [ACCOUNT, "alice-SENTINEL", IP, "203.0.113", PEPPER]) expect(all, raw).not.toContain(raw);
  });

  test("another pepper gives other hashes, so a hash cannot be matched without it", async () => {
    const a = await sent(row());
    const t = fake();
    await make(t.f, { pepper: "another-pepper-0123456789abcdef" }).insertAttempt(row());
    expect(t.calls[0]!.body.account_hash).not.toBe(a.account_hash);
  });

  test("sends exactly the columns the schema has, ignoring anything extra on the row", async () => {
    const body = await sent({ ...row(), extra: "x", hidden: true, password: "p" } as AttemptRow);
    expect(Object.keys(body).sort()).toEqual(
      ["account_hash", "attestation_sha256", "chain_txid", "codehash", "consent_version", "fw_a", "fw_b", "id", "ip_hash", "leaf", "llm_output", "message", "model_id", "near_tx", "normalized", "outcome", "payout_address", "prompt_sha256", "reply", "stage", "technique", "tier", "tool_called", "ts"],
    );
  });

  test("llm_output goes as JSON text, and null when the model never ran", async () => {
    const r = row();
    expect(JSON.parse((await sent(r)).llm_output)).toEqual(r.llm_output);
    expect((await sent(row({ llm_output: undefined }))).llm_output).toBeNull();
    expect((await sent(row({ llm_output: null }))).llm_output).toBeNull();
  });

  test("llm_output with keys Convex would refuse, or nesting it would refuse, is just text", async () => {
    const nasty: any = { $set: 1, "": 2, "a.b": 3 };
    let deep: any = nasty;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    const body = await sent(row({ llm_output: deep }));
    expect(typeof body.llm_output).toBe("string");
    expect(JSON.parse(body.llm_output)).toEqual(deep);
  });

  test("firewall objects keep their eight fields and drop everything else", async () => {
    const body = await sent(row({ fw_a: { ...FW, evil: "x", signature: "s" } as never, fw_b: { ...FW, verdict: "block" } }));
    expect(body.fw_a).toEqual(FW);
    expect(body.fw_b).toEqual({ ...FW, verdict: "block" });
    expect((await sent(row({ fw_a: null }))).fw_a).toBeNull();
  });

  test("the leaf is computed here, over the hash and the fields the verifier has, and ts goes as written", async () => {
    const r = row();
    const body = await sent(r);
    expect(body.ts).toBe("2026-11-02T12:34:56.789Z");
    expect(body.leaf).toBe(attemptLeaf({ id: r.id, ts: r.ts, tier: r.tier, account_hash: sha(ACCOUNT + PEPPER), message: r.message, outcome: r.outcome, prompt_sha256: r.prompt_sha256, model_id: r.model_id, attestation_sha256: r.attestation_sha256, codehash: r.codehash }));
  });

  test("the leaf written for a releasing row is the one the final row recomputes to", async () => {
    const releasing = await sent(row({ outcome: "releasing" }));
    for (const outcome of ["drained", "signed_pending_broadcast", "release_failed", "broadcast_failed_terminal"] as const) {
      const final = attemptLeaf({ ...row({ outcome }), account_hash: releasing.account_hash });
      expect(final).toBe(releasing.leaf);
    }
  });

  test("a lone surrogate in player or model text is replaced before sending, so Convex's JSON parser cannot refuse the row", async () => {
    const lone = "a\ud800b";
    const body = await sent(row({ message: lone, normalized: lone, reply: lone, fw_a: { ...FW, reason: lone } }));
    expect(body.message).toBe("a\uFFFDb");
    expect(body.normalized).toBe("a\uFFFDb");
    expect(body.reply).toBe("a\uFFFDb");
    expect(body.fw_a.reason).toBe("a\uFFFDb");
    // and the leaf covers the message as stored, which is what the dataset will hold
    expect(body.leaf).toBe(attemptLeaf({ id: idN(1), ts: row().ts, tier: 3, account_hash: sha(ACCOUNT + PEPPER), message: "a\uFFFDb", outcome: "refused", prompt_sha256: H("c"), model_id: row().model_id, attestation_sha256: H("d"), codehash: "local" }));
  });

  test("a reply sent with an update is well-formed text too, and unset fields are not sent", async () => {
    const t = fake();
    await make(t.f).updateAttempt(idN(1), { outcome: "drained", reply: "a\ud800b" });
    expect(t.calls[0]!.body).toEqual({ id: idN(1), outcome: "drained", reply: "a\uFFFDb" });
  });

  test("an account or ip that is not a non-empty string is refused, so no two of them hash to the same value", async () => {
    const t = fake();
    const db = make(t.f);
    for (const o of [{ account: "" }, { account: undefined }, { ip: "" }, { ip: 5 }]) await expect(db.insertAttempt(row(o as never))).rejects.toThrow(TypeError);
    await expect(db.report({ attempt_id: idN(1), account: "" })).rejects.toThrow(TypeError);
    expect(t.calls).toEqual([]);
  });

  test("a leaf that cannot be computed (bad ts) stops the insert before anything is sent", async () => {
    const t = fake();
    await expect(make(t.f).insertAttempt(row({ ts: "yesterday" }))).rejects.toThrow("leaf ts");
    expect(t.calls).toEqual([]);
  });

  test("a bad row is refused by Convex and surfaces as a DbError 400", async () => {
    const z = setup();
    const db = makeDb({ fetch: bridge(z.t), siteUrl: SITE, secret: SECRET, pepper: PEPPER });
    await expect(db.insertAttempt(row({ message: "x".repeat(2001) }))).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
});

// db.ts over the real Convex functions: the fetch goes straight into convex-test's HTTP router.
const bridge = (t: ReturnType<typeof setup>["t"]) => (async (url: string, init: RequestInit) => t.fetch(new URL(url).pathname, init)) as unknown as typeof globalThis.fetch;

describe("through the Convex functions", () => {
  const rig = () => {
    const z = setup();
    return { ...z, db: makeDb({ fetch: bridge(z.t), siteUrl: SITE, secret: SECRET, pepper: PEPPER }) };
  };

  test("an attempt written by db.ts holds hashes and no raw account or IP, anywhere in the store", async () => {
    const z = rig();
    await z.db.insertAttempt(row({ outcome: "releasing", stage: "signing" }));
    const stored = JSON.stringify(await z.dump());
    expect(stored).toContain(sha(ACCOUNT + PEPPER));
    for (const raw of [ACCOUNT, "alice-SENTINEL", IP, PEPPER, SECRET]) expect(stored, raw).not.toContain(raw);
  });

  test("insert, stage, finish and read back through the public query", async () => {
    const z = rig();
    await z.db.insertAttempt(row({ outcome: "releasing", stage: "signing", reply: "model text" }));
    expect(await z.db.setStage(idN(1), "broadcasting")).toBe(true);
    expect(await z.db.setStage(idN(1), "signing")).toBe(false);
    await z.db.updateAttempt(idN(1), { outcome: "drained", reply: "You won.", near_tx: "n", chain_txid: "c" });
    expect(await z.t.query(api.attempts.get, { id: idN(1) })).toMatchObject({ outcome: "drained", stage: "done", reply: "You won.", near_tx: "n", chain_txid: "c" });
  });

  test("a stage for a row that does not exist yet is false, not an error", async () => {
    expect(await rig().db.setStage(idN(5), "thinking")).toBe(false);
  });

  test("replays, API keys, signed transactions, reports and the export", async () => {
    const z = rig();
    await z.db.insertAttempt(row({ outcome: "releasing", stage: "signing" }));
    expect(await z.db.insertReplay({ attempt_id: idN(1), fw_version: "fw-v1", verdict: "block", risk: 90 })).toBe(true);
    expect(await z.db.insertReplay({ attempt_id: idN(1), fw_version: "fw-v1", verdict: "allow", risk: 1 })).toBe(false);
    const key = sha("dm_live_secret_key");
    expect(await z.db.apiKeyExists(key)).toBe(false);
    expect(await z.db.putApiKey(key, "me")).toBe(true);
    expect(await z.db.apiKeyExists(key)).toBe(true);
    expect(await z.db.getSignedTx(idN(1))).toBeNull();
    expect(await z.db.putSignedTx({ attempt_id: idN(1), chain: "btc", hex: "0200abcd" })).toBe(true);
    expect(await z.db.getSignedTx(idN(1))).toEqual({ chain: "btc", hex: "0200abcd" });
    await expect(z.db.putSignedTx({ attempt_id: idN(1), chain: "btc", hex: "0200ffff" })).rejects.toMatchObject({ status: 409 });
    expect(await z.db.report({ attempt_id: idN(1), account: "r1.near" })).toEqual({ hidden: false });
    expect(await z.db.report({ attempt_id: idN(1), account: "r2.near" })).toEqual({ hidden: false });
    expect(await z.db.report({ attempt_id: idN(1), account: "r3.near" })).toEqual({ hidden: true });
    const stored = JSON.stringify(await z.dump());
    for (const raw of ["r1.near", "r2.near", "r3.near"]) expect(stored).not.toContain(raw);
    expect(stored).toContain(sha("r1.near" + PEPPER));
    const page = await z.db.listAttempts("", null, 10);
    expect(page.rows.map(r => r.id)).toEqual([idN(1)]);
    expect(page.rows[0]!.hidden).toBe(true);
  });

  test("listAttempts pages with the cursor until done", async () => {
    const z = rig();
    for (const n of [1, 2, 3]) await z.db.insertAttempt(row({ id: idN(n), ts: `2026-11-02T12:00:0${n}.000Z` }));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await z.db.listAttempts("", cursor, 2);
      seen.push(...page.rows.map(r => r.id as string));
      if (page.done) break;
      cursor = page.next;
    }
    expect(seen).toEqual([idN(1), idN(2), idN(3)]);
  });

  test("health fails when the secret is wrong, so a misconfigured agent reports db_unavailable at once", async () => {
    const z = setup();
    const db = makeDb({ fetch: bridge(z.t), siteUrl: SITE, secret: "wrong-secret-wrong-secret", pepper: PEPPER });
    await expect(db.ping()).rejects.toMatchObject({ status: 401 });
  });
});

describe("the counter", () => {
  const rig = () => {
    const z = setup();
    return { ...z, db: makeDb({ fetch: bridge(z.t), siteUrl: SITE, secret: SECRET, pepper: PEPPER }) };
  };

  test("behaves like the in-memory counter on the same calls", async () => {
    const steps: [string, number, number | undefined][] = [["a", 2, undefined], ["a", 3, undefined], ["a", -1, undefined], ["a", 1, 5], ["a", 1, 5], ["b", 7, 7], ["b", 1, 7], ["b", -3, 7], ["b", 3, 7], ["c", 0, 0], ["c", 1, 0]];
    const mem = memoryCounter();
    const cvx = rig().db.counter;
    for (const [k, n, cap] of steps) expect(await cvx.add(k, n, cap), `${k} ${n} ${cap}`).toBe(await mem.add(k, n, cap));
    for (const k of ["a", "b", "c", "d"]) expect(await cvx.get(k)).toBe(await mem.get(k));
  });

  test("add sends no cap field when there is none", async () => {
    const t = fake(() => json({ result: 1 }));
    await make(t.f).counter.add("a", 1);
    await make(t.f).counter.add("a", 1, 9);
    expect(t.calls[0]!.body).toEqual({ key: "a", n: 1 });
    expect(t.calls[1]!.body).toEqual({ key: "a", n: 1, cap: 9 });
  });

  test("an answer that is not a number is an error, never a count", async () => {
    await expect(make(fake(() => json({ result: "7" })).f).counter.get("a")).rejects.toBeInstanceOf(DbError);
    await expect(make(fake(() => json({ result: "7" })).f).counter.add("a", 1)).rejects.toBeInstanceOf(DbError);
    await expect(make(fake(() => json({ result: undefined })).f).counter.get("a")).rejects.toBeInstanceOf(DbError);
    await expect(make(fake(() => json({ result: null })).f).counter.get("a")).rejects.toBeInstanceOf(DbError);
    expect(await make(fake(() => json({ result: null })).f).counter.add("a", 1, 1)).toBeNull();
  });

  test("the firewall budget over Convex counters: concurrent charges never pass the daily limit", async () => {
    const { db } = rig();
    const budget = makeBudget({ counter: db.counter, clock: () => Date.UTC(2026, 10, 2, 12), limits: { arena: 7 } });
    const r = await Promise.all(Array.from({ length: 20 }, () => budget.chargeArena()));
    expect(r.filter(Boolean).length).toBe(7);
  });

  test("the budget's API pools behave as with memory: a key over its quota never reaches the global pool, and a refused global call is taken back", async () => {
    const { db } = rig();
    const clock = () => Date.UTC(2026, 10, 2, 12);
    const budget = makeBudget({ counter: db.counter, clock, limits: { apiKey: 2, apiGlobal: 3 } });
    expect([await budget.chargeApi("k1"), await budget.chargeApi("k1"), await budget.chargeApi("k1")]).toEqual([true, true, false]);
    expect(await budget.chargeApi("k2")).toBe(true);
    expect(await budget.chargeApi("k2")).toBe(false); // global is 3, so the global pool refuses and k2's count is given back
    expect(await db.counter.get("fw:key:k2:2026-11-02")).toBe(1);
  });

  test("the NEAR AI spend cap over Convex counters: reserve, settle, and refuse past the cap", async () => {
    const { db } = rig();
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
    }) as unknown as typeof globalThis.fetch;
    const T0 = Date.UTC(2026, 10, 2, 12);
    const ai = makeNearAI({ fetch, apiKey: "k", base: "https://nearai.test/v1", prices: { m: { in: 1, out: 2 } }, counter: db.counter, clock: () => T0, dailyUsd: 0.0045, onAlert: () => {} });
    const req = { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 400, timeoutMs: 1000 };
    await ai.chat(req);
    await ai.chat(req);
    expect(await db.counter.get("nearai:spend:2026-11-02")).toBe(4000); // each call settled to 2000
    await expect(ai.chat(req)).rejects.toMatchObject({ code: "spend_cap" });
    expect(calls).toBe(2);
    expect(await db.counter.get("nearai:spend:2026-11-02")).toBe(4000); // the refused reservation was given back
  });
});

describe("raw values never reach Convex", () => {
  test("every op's body, for every method, is free of the raw account and IP", async () => {
    const t = fake(() => json({ result: null }));
    const db = make(t.f);
    await db.insertAttempt(row());
    await db.report({ attempt_id: idN(1), account: ACCOUNT });
    await db.updateAttempt(idN(1), { outcome: "drained", reply: "ok", near_tx: "n", chain_txid: "c" });
    await db.setStage(idN(1), "done");
    await db.insertReplay({ attempt_id: idN(1), fw_version: "fw-v1", verdict: "allow", risk: 1 });
    await db.putSignedTx({ attempt_id: idN(1), chain: "btc", hex: "ab" });
    await db.counter.add("k", 1, 2);
    expect(t.calls.length).toBe(7);
    for (const c of t.calls) for (const raw of [ACCOUNT, IP]) expect(JSON.stringify(c.body), `${c.op} ${raw}`).not.toContain(raw);
    expect(t.calls[1]!.body.account_hash).toBe(sha(ACCOUNT + PEPPER));
  });
});
