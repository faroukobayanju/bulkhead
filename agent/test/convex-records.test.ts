import { beforeEach, describe, expect, test } from "bun:test";
import { api, H, idN, setup, wireRow } from "./convex-harness";

let s: ReturnType<typeof setup>;
beforeEach(() => void (s = setup()));
const add = (key: string, n: number, cap?: number) => s.post("counter_add", cap === undefined ? { key, n } : { key, n, cap }).then(r => r.json.result as number | null);
const get = (key: string) => s.post("counter_get", { key }).then(r => r.json.result as number);

describe("counters", () => {
  test("add and get, starting at zero, negative n settles", async () => {
    expect(await get("a")).toBe(0);
    expect(await add("a", 2)).toBe(2);
    expect(await add("a", 3)).toBe(5);
    expect(await add("a", -1)).toBe(4);
    expect(await get("a")).toBe(4);
    expect(await get("b")).toBe(0);
  });

  test("a capped add stops at the cap and adds nothing past it", async () => {
    expect(await add("a", 1, 2)).toBe(1);
    expect(await add("a", 1, 2)).toBe(2);
    expect(await add("a", 1, 2)).toBeNull();
    expect(await get("a")).toBe(2);
  });

  test("a capped add that would pass the cap adds nothing, even for a large n", async () => {
    expect(await add("a", 5, 10)).toBe(5);
    expect(await add("a", 6, 10)).toBeNull();
    expect(await get("a")).toBe(5);
    expect(await add("a", 5, 10)).toBe(10);
  });

  test("a capped add that lands on a zero cap, and a cap of zero from a fresh key", async () => {
    expect(await add("z", 1, 0)).toBeNull();
    expect(await add("z", 0, 0)).toBe(0);
    expect(await get("z")).toBe(0);
  });

  test("concurrent capped adds never pass the cap", async () => {
    const r = await Promise.all(Array.from({ length: 20 }, () => add("a", 1, 7)));
    expect(r.filter(x => x !== null).length).toBe(7);
    expect(await get("a")).toBe(7);
    expect((await s.dump()).counters.filter(c => c.key === "a").length).toBe(1);
  });

  test("concurrent uncapped adds all land, on one row", async () => {
    await Promise.all(Array.from({ length: 25 }, () => add("a", 2)));
    expect(await get("a")).toBe(50);
    expect((await s.dump()).counters.length).toBe(1);
  });

  test("a reservation and its settlement, as the spend cap uses them, never pass the cap in flight", async () => {
    // 5 calls each reserve 40 of 100, then settle to 10: only 2 fit at first, the rest are refused while those are in flight
    const reserved = await Promise.all(Array.from({ length: 5 }, () => add("spend", 40, 100)));
    expect(reserved.filter(x => x !== null).length).toBe(2);
    await add("spend", -30);
    await add("spend", -30);
    expect(await get("spend")).toBe(20);
  });

  test("the same key used in two days stays separate", async () => {
    await add("fw:arena:2026-11-02", 1, 3);
    await add("fw:arena:2026-11-03", 1, 3);
    expect(await get("fw:arena:2026-11-02")).toBe(1);
    expect(await get("fw:arena:2026-11-03")).toBe(1);
  });

  test.each([
    ["an empty key", { key: "", n: 1 }],
    ["a key over 200 characters", { key: "k".repeat(201), n: 1 }],
    ["n as a string", { key: "a", n: "1" }],
    ["n that JSON reads as Infinity", "{\"key\":\"a\",\"n\":1e999}"],
    ["a cap that JSON reads as Infinity", "{\"key\":\"a\",\"n\":1,\"cap\":1e999}"],
    ["a missing n", { key: "a" }],
    ["an extra field", { key: "a", n: 1, extra: 1 }],
  ])("%s is a 400 and changes nothing", async (_, body) => {
    expect((await s.post("counter_add", body)).status).toBe(400);
    expect((await s.dump()).counters).toEqual([]);
  });

  test("a total that overflows to Infinity is refused", async () => {
    await add("a", Number.MAX_VALUE);
    expect((await s.post("counter_add", { key: "a", n: Number.MAX_VALUE })).status).toBe(400);
    expect(await get("a")).toBe(Number.MAX_VALUE);
  });

  test("tiers is the public view of the per-tier counters", async () => {
    await s.post("attempt_insert", wireRow({ id: idN(1), tier: 1 }));
    await s.post("attempt_insert", wireRow({ id: idN(2), tier: 3, outcome: "blocked_b" }));
    await s.post("attempt_insert", wireRow({ id: idN(3), tier: 3 }));
    expect(await s.t.query(api.counters.tiers, {})).toEqual([
      { tier: 1, attempts: 1, nearMisses: 0 },
      { tier: 2, attempts: 0, nearMisses: 0 },
      { tier: 3, attempts: 2, nearMisses: 1 },
    ]);
  });
});

describe("replays", () => {
  const put = (o: Record<string, unknown> = {}) => s.post("replay_put", { attempt_id: idN(1), fw_version: "fw-v1", verdict: "block", risk: 90, ...o });

  test("the first verdict for an attempt and firewall version stands", async () => {
    expect((await put()).json.result).toBe(true);
    expect((await put({ verdict: "allow", risk: 3 })).json.result).toBe(false);
    const rows = (await s.dump()).replays;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ attempt_id: idN(1), fw_version: "fw-v1", verdict: "block", risk: 90 });
    expect(rows[0]!.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test("another firewall version, or another attempt, is its own row", async () => {
    await put();
    expect((await put({ fw_version: "fw-v2" })).json.result).toBe(true);
    expect((await put({ attempt_id: idN(2) })).json.result).toBe(true);
    expect((await s.dump()).replays.length).toBe(3);
  });

  test("a bad verdict is a 400", async () => {
    expect((await put({ verdict: "maybe" })).status).toBe(400);
    expect((await put({ risk: "high" })).status).toBe(400);
  });
});

describe("api keys", () => {
  test("exists is false, put stores the hash once, exists is then true", async () => {
    expect((await s.post("key_exists", { key_hash: H("a") })).json.result).toBe(false);
    expect((await s.post("key_put", { key_hash: H("a"), label: "mine" })).json.result).toBe(true);
    expect((await s.post("key_put", { key_hash: H("a") })).json.result).toBe(false);
    expect((await s.post("key_exists", { key_hash: H("a") })).json.result).toBe(true);
    expect((await s.post("key_exists", { key_hash: H("b") })).json.result).toBe(false);
    expect((await s.dump()).api_keys).toMatchObject([{ key_hash: H("a"), label: "mine" }]);
  });

  test("something that is not a sha256 is a 400, so a raw key cannot be stored", async () => {
    expect((await s.post("key_put", { key_hash: "dm_live_secret" })).status).toBe(400);
    expect((await s.post("key_exists", { key_hash: "dm_live_secret" })).status).toBe(400);
    expect((await s.dump()).api_keys).toEqual([]);
  });
});

describe("signed txs", () => {
  const withAttempt = () => s.post("attempt_insert", wireRow({ outcome: "releasing", stage: "signing" }));
  const put = (o: Record<string, unknown> = {}) => s.post("signed_tx_put", { attempt_id: wireRow().id, chain: "btc", hex: "02000000abcdef", ...o });

  test("stores the first hex and returns it", async () => {
    await withAttempt();
    expect((await put()).json.result).toBe(true);
    expect((await s.post("signed_tx_get", { attempt_id: wireRow().id })).json.result).toEqual({ chain: "btc", hex: "02000000abcdef" });
  });

  test("the same hex again changes nothing; a different hex is a conflict and never overwrites", async () => {
    await withAttempt();
    await put();
    expect((await put()).json.result).toBe(false);
    const r = await put({ hex: "02000000ffffff" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("conflict");
    expect((await s.dump()).signed_txs).toMatchObject([{ hex: "02000000abcdef" }]);
  });

  test("needs an attempt row, and an unknown id reads as null", async () => {
    expect((await put()).status).toBe(404);
    expect((await s.dump()).signed_txs).toEqual([]);
    expect((await s.post("signed_tx_get", { attempt_id: idN(9) })).json.result).toBeNull();
  });

  test.each([
    ["non-hex", { hex: "zz" }],
    ["odd-length hex", { hex: "abc" }],
    ["empty hex", { hex: "" }],
    ["a 0x prefix", { hex: "0xabcd" }],
    ["an oversized hex", { hex: "ab".repeat(10_001) }],
    ["an unknown chain", { chain: "sol" }],
  ])("%s is a 400", async (_, o) => {
    await withAttempt();
    expect((await put(o)).status).toBe(400);
    expect((await s.dump()).signed_txs).toEqual([]);
  });

  test("an EVM raw transaction is stored too", async () => {
    await withAttempt();
    expect((await put({ chain: "evm", hex: "02f8" + "ab".repeat(100) })).json.result).toBe(true);
  });
});
