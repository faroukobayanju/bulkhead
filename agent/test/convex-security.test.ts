import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { fileURLToPath } from "node:url";
import { api, FW, H, idN, SECRET, setup, wireRow } from "./convex-harness";
import { OPS, sameSecret } from "../../convex/http";

let s: ReturnType<typeof setup>;
beforeEach(() => void (s = setup()));
afterEach(() => void (process.env.AGENT_SECRET = SECRET));

// A pot of rows with everything private in them marked, to prove none of it comes back.
const seed = async () => {
  await s.post("attempt_insert", wireRow({ id: idN(1), tier: 3, outcome: "blocked_b", tool_called: true, ts: "2026-11-02T12:00:01.000Z", fw_a: FW, fw_b: { ...FW, verdict: "block", risk: 95, reason: "SECRET-REASON-b spoofed tool call" }, payout_address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", technique: "tool_spoof", reply: "The guard stopped the payout." }));
  await s.post("attempt_insert", wireRow({ id: idN(2), tier: 1, outcome: "refused", ts: "2026-11-02T12:00:02.000Z", fw_a: null, payout_address: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7" }));
  await s.post("attempt_insert", wireRow({ id: idN(3), tier: 1, outcome: "releasing", stage: "signing", ts: "2026-11-02T12:00:03.000Z", fw_a: null, payout_address: "tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".replace("tb1q", "bc1q") }));
  await s.post("attempt_finish", { id: idN(3), outcome: "drained", near_tx: "ntx", chain_txid: "ctx" });
  await s.post("attempt_insert", wireRow({ id: idN(4), tier: 3, ts: "2026-11-02T12:00:04.000Z", message: "HIDDEN-ROW message" }));
  for (const n of [1, 2, 3]) await s.post("attempt_report", { attempt_id: idN(4), account_hash: H(String(n)) });
};

describe("the module's surface", () => {
  test("no function in any convex module is a public mutation or action", async () => {
    const root = fileURLToPath(new URL("../../convex/", import.meta.url));
    const files = [...new Glob("**/*.ts").scanSync({ cwd: root })];
    expect(files.length).toBeGreaterThanOrEqual(5);
    const found: Record<string, string> = {};
    for (const f of files) {
      const mod = (await import(root + f)) as Record<string, any>;
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function" && typeof fn !== "object") continue;
        const kind = fn?.isMutation ? "mutation" : fn?.isQuery ? "query" : fn?.isAction ? "action" : null;
        if (!kind) continue;
        found[`${f.replace(/\.ts$/, "")}:${name}`] = `${fn.isPublic ? "public" : fn.isInternal ? "internal" : "?"} ${kind}`;
      }
    }
    expect(Object.entries(found).filter(([, v]) => v.startsWith("public") && v !== "public query")).toEqual([]);
    expect(Object.entries(found).filter(([, v]) => v.startsWith("?"))).toEqual([]);
    // the whole public surface, so a new public function has to be added here on purpose
    expect(Object.entries(found).filter(([, v]) => v === "public query").map(([k]) => k).sort()).toEqual(["attempts:get", "attempts:nearMisses", "attempts:pendingBroadcasts", "attempts:recent", "attempts:winners", "counters:tiers"]);
  });

  test("every function the HTTP action can call is internal", async () => {
    const root = fileURLToPath(new URL("../../convex/", import.meta.url));
    for (const [op, def] of Object.entries(OPS)) {
      const [file, name] = def.name.split(":") as [string, string];
      const fn = ((await import(`${root}${file}.ts`)) as Record<string, any>)[name];
      expect(fn, `${op} -> ${def.name}`).toBe(def.fn); // the table calls the function it names
      expect(fn?.isInternal, `${op} -> ${def.name}`).toBe(true);
      expect(fn?.isPublic, `${op} -> ${def.name}`).toBeUndefined();
    }
  });

  test("the HTTP router has the one agent route and nothing else", async () => {
    const http = (await import("../../convex/http")).default as any;
    expect(http.exactRoutes.size).toBe(0);
    expect([...http.prefixRoutes.keys()]).toEqual(["POST"]);
    expect([...http.prefixRoutes.get("POST").keys()]).toEqual(["/agent/"]);
  });
});

describe("a client with no secret cannot write through anything", () => {
  const bodyFor: Record<string, unknown> = {
    health: {},
    attempt_insert: wireRow(),
    attempt_finish: { id: wireRow().id, outcome: "drained" },
    attempt_get: { id: wireRow().id },
    attempt_sent: { id: wireRow().id, release_tx: "t".repeat(44), release_ref_height: 1 },
    attempts_payouts: { drained_since: "" },
    attempt_stage: { id: wireRow().id, stage: "done" },
    attempt_report: { attempt_id: wireRow().id, account_hash: H("1") },
    attempts_export: { since: "", cursor: null, limit: 10 },
    replay_put: { attempt_id: idN(1), fw_version: "fw-v1", verdict: "block", risk: 90 },
    replay_todo: { fw_version: "fw-v1", cursor: null, limit: 10 },
    key_exists: { key_hash: H("a") },
    key_put: { key_hash: H("a") },
    signed_tx_put: { attempt_id: wireRow().id, chain: "btc", hex: "abcd" },
    signed_tx_get: { attempt_id: wireRow().id },
    counter_add: { key: "a", n: 1 },
    counter_get: { key: "a" },
  };

  test("the bodies below cover every op", () => {
    expect(Object.keys(bodyFor).sort()).toEqual(Object.keys(OPS).sort());
  });

  const cases: [string, Record<string, string>][] = [
    ["no header", {}],
    ["an empty header", { "x-agent-secret": "" }],
    ["a wrong secret of the same length", { "x-agent-secret": SECRET.replace(/.$/, "!") }],
    ["a wrong secret of another length", { "x-agent-secret": "short" }],
    ["the secret with a character added", { "x-agent-secret": SECRET + "x" }],
    ["the secret with a character missing", { "x-agent-secret": SECRET.slice(0, -1) }],
    ["the secret in another header", { authorization: `Bearer ${SECRET}`, "x-api-key": SECRET }],
    ["the secret in a different case", { "x-agent-secret": SECRET.toUpperCase() }],
  ];
  test.each(cases)("%s: every op is a 401 and nothing is written", async (_, headers) => {
    for (const [op, body] of Object.entries(bodyFor)) {
      const r = await s.post(op, body, headers);
      expect(r.status, op).toBe(401);
      expect(r.json, op).toEqual({ error: "unauthorized" });
    }
    const all = await s.dump();
    expect(Object.values(all).flat()).toEqual([]);
  });

  test("with the right secret the same bodies are accepted (the 401s above are about the secret and nothing else)", async () => {
    await s.post("attempt_insert", wireRow({ outcome: "releasing", stage: "signing" }));
    for (const op of ["health", "attempts_export", "replay_todo", "key_exists", "signed_tx_get", "counter_get", "attempt_stage", "attempt_get"]) {
      expect((await s.post(op, bodyFor[op])).status, op).toBe(200);
    }
  });

  test("when AGENT_SECRET is not set, every request is a 401, whatever header it carries", async () => {
    delete process.env.AGENT_SECRET;
    for (const h of [{}, { "x-agent-secret": "" }, { "x-agent-secret": "undefined" }, { "x-agent-secret": SECRET }] as Record<string, string>[]) {
      expect((await s.post("health", {}, h)).status).toBe(401);
    }
    process.env.AGENT_SECRET = "";
    expect((await s.post("health", {}, { "x-agent-secret": "" })).status).toBe(401);
  });

  test("the unauthenticated answer is the same for an unknown op, so no op names leak", async () => {
    const a = await s.post("nope", {}, {});
    const b = await s.post("health", {}, {});
    expect(a).toEqual(b);
  });
});

describe("sameSecret", () => {
  test("equal strings match; anything else, including unset, does not", async () => {
    expect(await sameSecret("abc", "abc")).toBe(true);
    expect(await sameSecret("abc", "abd")).toBe(false);
    expect(await sameSecret("abc", "abcd")).toBe(false);
    expect(await sameSecret("abcd", "abc")).toBe(false);
    expect(await sameSecret("", "")).toBe(false);
    expect(await sameSecret(null, "abc")).toBe(false);
    expect(await sameSecret(undefined, undefined)).toBe(false);
    expect(await sameSecret("abc", undefined)).toBe(false);
    expect(await sameSecret("abc", "")).toBe(false);
    expect(await sameSecret("\u00e9", "\u00e9")).toBe(true);
  });
});

describe("routing", () => {
  test("an unknown op is a 404 for an authenticated caller", async () => {
    const r = await s.post("nope", {});
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "unknown_op" });
  });

  test.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "", "health/", "HEALTH", "he%61lth", "health%2f", "../health", "attempt_insert/extra", "attempt_insert.json"])("op %p is a 404, not a lookup on Object.prototype", async op => {
    const r = await s.post(op, {});
    expect(r.status).toBe(404);
  });

  test("a GET, PUT or DELETE is not routed", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await s.t.fetch("/agent/health", { method, headers: { "x-agent-secret": SECRET } });
      expect(res.status).toBe(404);
    }
  });

  test("health answers 200 with the secret", async () => {
    const r = await s.post("health", {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ result: true });
  });
});

describe("invalid bodies", () => {
  test.each([
    ["not JSON", "{nope"],
    ["an empty body for an op that needs fields", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a JSON string", '"x"'],
    ["a number", "7"],
  ])("%s is a 400 for attempt_insert", async (_, body) => {
    const r = await s.post("attempt_insert", body);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("bad_request");
    expect((await s.dump()).attempts).toEqual([]);
  });

  test("the answer names the field and never echoes its value", async () => {
    const r = await s.post("attempt_insert", wireRow({ account_hash: "alice.near-SENTINEL" }));
    expect(r.status).toBe(400);
    expect(r.text).toContain("account_hash");
    expect(r.text).not.toContain("SENTINEL");
  });

  test("a body over 512 KiB is a 413 and is not parsed", async () => {
    const r = await s.post("attempt_insert", JSON.stringify(wireRow({ message: "x".repeat(600_000) })));
    expect(r.status).toBe(413);
  });

  test("an op with no arguments takes an empty object or no body", async () => {
    expect((await s.post("health", "")).status).toBe(200);
    expect((await s.post("health", "{}")).status).toBe(200);
    expect((await s.post("health", { extra: 1 })).status).toBe(400);
  });

  test("a body that tries to smuggle a Convex system field or a reserved key is a 400", async () => {
    const base = JSON.stringify(wireRow()).slice(0, -1);
    for (const extra of ['"_id":"x"', '"_creationTime":1', '"$integer":"AAAA"', '"__proto__":{"hidden":true}', '"constructor":1', '"hidden":true']) {
      const r = await s.post("attempt_insert", `${base},${extra}}`);
      expect(r.status, extra).toBe(400);
    }
    expect((await s.dump()).attempts).toEqual([]);
  });

  test("typed errors map to their status, and anything else is a 500 that says nothing about what failed", async () => {
    const { ConvexError } = await import("convex/values");
    const { errorResponse } = await import("../../convex/http");
    for (const [code, status] of [["bad_request", 400], ["not_found", 404], ["conflict", 409], ["bad_transition", 409]] as const) {
      const r = errorResponse(new ConvexError({ code, detail: "d" }));
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ error: code, detail: "d" });
    }
    for (const e of [new Error("db password is hunter2"), "str", null, new ConvexError({ code: "other" }), new ConvexError("plain")]) {
      const r = errorResponse(e);
      expect(r.status).toBe(500);
      expect(await r.text()).toBe('{"error":"internal"}');
    }
  });
});

describe("public queries", () => {
  const PRIVATE = ["ip_hash", "account_hash", "hidden", "llm_output", "normalized", "payout_address", "consent_version", "prompt_sha256", "attestation_sha256", "codehash", "leaf", "model_id", "reason", "_id", "_creationTime"];
  const flat = (x: unknown): string[] => (x && typeof x === "object" ? Object.entries(x as object).flatMap(([k, v]) => [k, ...flat(v)]) : []);
  const text = (x: unknown) => JSON.stringify(x);

  test("the fields of an attempt are an explicit list", async () => {
    await seed();
    const row = (await s.t.query(api.attempts.get, { id: idN(1) })) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["chain_txid", "fw_a", "fw_b", "id", "message", "near_tx", "outcome", "payout", "reply", "response_verified", "signature", "signer", "stage", "technique", "tier", "tool_called", "ts"]);
  });

  test("nothing private comes back from any public query: not as a key, and not as a value", async () => {
    await seed();
    const results = [
      await s.t.query(api.attempts.get, { id: idN(1) }),
      await s.t.query(api.attempts.get, { id: idN(2) }),
      await s.t.query(api.attempts.get, { id: idN(3) }),
      await s.t.query(api.attempts.recent, {}),
      await s.t.query(api.attempts.recent, { tier: 3 }),
      await s.t.query(api.attempts.nearMisses, {}),
      await s.t.query(api.attempts.winners, {}),
      await s.t.query(api.attempts.pendingBroadcasts, {}),
      await s.t.query(api.counters.tiers, {}),
    ];
    for (const r of results) {
      const keys = flat(r);
      for (const p of PRIVATE) expect(keys, `a ${p} key`).not.toContain(p);
      const t = text(r);
      for (const marker of [H("a"), H("b"), H("c"), H("d"), H("e"), "SECRET-REASON", "SECRET-LLM-OUTPUT", "consent-v1", "deepseek-ai", "local"]) expect(t, marker).not.toContain(marker);
    }
  });

  test("firewall reason is gone from fw_a and fw_b, however deep, and only a list of fields is kept", async () => {
    await seed();
    const row = (await s.t.query(api.attempts.get, { id: idN(1) })) as any;
    expect(row.fw_a).toEqual({ verdict: "allow", risk: 12, technique: "none", firewall_version: "fw-v1", degraded: false });
    expect(row.fw_b).toEqual({ verdict: "block", risk: 95, technique: "none", firewall_version: "fw-v1", degraded: false });
    expect(text(row)).not.toContain("SECRET-REASON");
    const none = (await s.t.query(api.attempts.get, { id: idN(2) })) as any;
    expect(none.fw_a).toBeNull();
    expect(none.fw_b).toBeNull();
  });

  test("the projection is an allowlist: a reason planted in a firewall object at any depth is still not returned", async () => {
    const { publicAttempt } = await import("../../convex/lib/public");
    const evil = { ...FW, reason: "SECRET-REASON-x", nested: { reason: "SECRET-REASON-y", deeper: [{ reason: "SECRET-REASON-z" }] }, extra: "SECRET-REASON-w" };
    const doc = { ...wireRow({ outcome: "blocked_b", fw_a: evil, fw_b: evil }), hidden: false, _id: "x", _creationTime: 1, secretNewColumn: "SECRET-REASON-v" } as never;
    const out = publicAttempt(doc);
    expect(text(out)).not.toContain("SECRET-REASON");
    expect(Object.keys(out.fw_a!).sort()).toEqual(["degraded", "firewall_version", "risk", "technique", "verdict"]);
    expect(Object.keys(out).sort()).toEqual(["chain_txid", "fw_a", "fw_b", "id", "message", "near_tx", "outcome", "payout", "reply", "response_verified", "signature", "signer", "stage", "technique", "tier", "tool_called", "ts"]);
  });

  test("a hidden row is returned by no public query", async () => {
    await seed();
    expect(await s.t.query(api.attempts.get, { id: idN(4) })).toBeNull();
    for (const r of [await s.t.query(api.attempts.recent, {}), await s.t.query(api.attempts.recent, { tier: 3 })]) {
      expect((r as any[]).map(x => x.id)).not.toContain(idN(4));
      expect(text(r)).not.toContain("HIDDEN-ROW");
    }
    // a hidden near miss is not listed either
    await s.t.run(async ctx => void (await ctx.db.insert("attempts", { ...wireRow({ id: idN(8), outcome: "blocked_b", message: "HIDDEN-NEAR-MISS" }), hidden: true } as never)));
    expect(text(await s.t.query(api.attempts.nearMisses, {}))).not.toContain("HIDDEN-NEAR-MISS");
    // and it still counts in the counters, which are not rows
    expect((await s.dump()).attempts.length).toBe(5);
  });

  test("recent is newest first, bounded, and can be limited to a tier", async () => {
    for (let n = 1; n <= 60; n++) await s.post("attempt_insert", wireRow({ id: idN(n), tier: (n % 3) + 1, ts: new Date(Date.UTC(2026, 10, 2, 12, 0, n)).toISOString() }));
    const all = (await s.t.query(api.attempts.recent, {})) as any[];
    expect(all.length).toBe(20);
    expect(all[0].id).toBe(idN(60));
    expect(all.map(x => x.ts)).toEqual([...all.map(x => x.ts)].sort().reverse());
    expect(((await s.t.query(api.attempts.recent, { limit: 3 })) as any[]).length).toBe(3);
    expect(((await s.t.query(api.attempts.recent, { limit: 50 })) as any[]).length).toBe(50);
    const t2 = (await s.t.query(api.attempts.recent, { tier: 2, limit: 50 })) as any[];
    expect(t2.length).toBe(20);
    expect(new Set(t2.map(x => x.tier))).toEqual(new Set([2]));
  });

  test.each([0, -1, 51, 1.5, NaN])("a limit of %p is refused", async limit => {
    await expect(s.t.query(api.attempts.recent, { limit })).rejects.toThrow();
  });

  test("nearMisses lists only visible blocked_b rows, newest first", async () => {
    await s.post("attempt_insert", wireRow({ id: idN(1), outcome: "blocked_b", ts: "2026-11-02T12:00:01.000Z" }));
    await s.post("attempt_insert", wireRow({ id: idN(2), outcome: "blocked_a", ts: "2026-11-02T12:00:02.000Z" }));
    await s.post("attempt_insert", wireRow({ id: idN(3), outcome: "blocked_b", ts: "2026-11-02T12:00:03.000Z" }));
    expect(((await s.t.query(api.attempts.nearMisses, {})) as any[]).map(x => x.id)).toEqual([idN(3), idN(1)]);
  });

  test("winners lists only visible drained and signed_pending_broadcast rows, newest first", async () => {
    await seed();
    await s.post("attempt_insert", wireRow({ id: idN(5), tier: 3, outcome: "releasing", stage: "signing", ts: "2026-11-02T12:00:05.000Z" }));
    await s.post("attempt_finish", { id: idN(5), outcome: "signed_pending_broadcast", near_tx: "ntx5" });
    await s.t.run(async ctx => void (await ctx.db.insert("attempts", { ...wireRow({ id: idN(9), outcome: "drained", message: "HIDDEN-WINNER" }), hidden: true } as never)));
    const rows = (await s.t.query(api.attempts.winners, {})) as any[];
    expect(rows.map(x => [x.id, x.outcome])).toEqual([[idN(5), "signed_pending_broadcast"], [idN(3), "drained"]]);
    expect(text(rows)).not.toContain("HIDDEN-WINNER");
  });

  test("pendingBroadcasts gives the signed hex of visible signed_pending_broadcast rows, and nothing else", async () => {
    await seed();
    for (const [n, hidden] of [[5, false], [6, true]] as const) {
      await s.post("attempt_insert", wireRow({ id: idN(n), tier: 1, outcome: "releasing", stage: "signing", ts: `2026-11-02T12:00:0${n}.000Z` }));
      await s.post("signed_tx_put", { attempt_id: idN(n), chain: "btc", hex: `0200000${n}ab` });
      await s.post("attempt_finish", { id: idN(n), outcome: "signed_pending_broadcast", near_tx: `ntx${n}` });
      if (hidden) for (const k of [1, 2, 3]) await s.post("attempt_report", { attempt_id: idN(n), account_hash: H(String(k)) });
    }
    // signed, but the hex is not stored yet: listed without one
    await s.post("attempt_insert", wireRow({ id: idN(7), tier: 3, outcome: "releasing", stage: "signing", ts: "2026-11-02T12:00:07.000Z" }));
    await s.post("attempt_finish", { id: idN(7), outcome: "signed_pending_broadcast" });
    const rows = (await s.t.query(api.attempts.pendingBroadcasts, {})) as any[];
    expect(rows).toEqual([
      { id: idN(7), tier: 3, ts: "2026-11-02T12:00:07.000Z", near_tx: null, chain: null, hex: null },
      { id: idN(5), tier: 1, ts: "2026-11-02T12:00:05.000Z", near_tx: "ntx5", chain: "btc", hex: "02000005ab" },
    ]);
  });

  test("only a winner's payout is shown, shortened; a near miss shows none", async () => {
    await seed();
    const near = (await s.t.query(api.attempts.get, { id: idN(1) })) as any;
    const refused = (await s.t.query(api.attempts.get, { id: idN(2) })) as any;
    const won = (await s.t.query(api.attempts.get, { id: idN(3) })) as any;
    expect(near.payout).toBeNull();
    expect(won.payout).toBe("bc1qar\u2026mdq");
    expect(refused.payout).toBeNull();
    for (const r of [near, won]) expect(text(r)).not.toContain("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
  });

  test("stage and result follow the row, so a subscriber sees the payout land", async () => {
    await s.post("attempt_insert", wireRow({ outcome: "releasing", stage: "signing", reply: "model text" }));
    expect(await s.t.query(api.attempts.get, { id: wireRow().id })).toMatchObject({ outcome: "releasing", stage: "signing", near_tx: null });
    await s.post("attempt_finish", { id: wireRow().id, outcome: "drained", reply: "You won.", near_tx: "n", chain_txid: "c" });
    expect(await s.t.query(api.attempts.get, { id: wireRow().id })).toMatchObject({ outcome: "drained", stage: "done", reply: "You won.", near_tx: "n", chain_txid: "c" });
  });

  test("an unknown id is null, and a malformed one is an error, not a scan", async () => {
    expect(await s.t.query(api.attempts.get, { id: idN(99) })).toBeNull();
    await expect(s.t.query(api.attempts.get, { id: 5 as never })).rejects.toThrow();
  });
});
