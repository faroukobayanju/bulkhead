import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { KeyPair } from "near-api-js";
import { ulid } from "ulid";
import { LOGIN_MESSAGE, LOGIN_RECIPIENT } from "../../shared/nep413";
import { makeNonce, nep413Hash } from "../src/auth";
import { makeViewAccessKey } from "../src/accesskey";
import { memoryCounter } from "../src/counter";
import type { FirewallResult } from "../src/firewall/api";
import { makeBudget } from "../src/firewall/budget";
import { SlidingWindow } from "../src/firewall/window";
import { BroadcastFailedError } from "../src/pipeline";
import { RateLimiter } from "../src/ratelimit";
import { AttestError } from "../src/attest";
import { trackCompletion } from "../src/completions";
import { errCode, makeAlert, makeServer, type ChainDeps, type ServerDeps } from "../src/server";

const PROXY = "p".repeat(32);
const SESSION = "s".repeat(32);
const BTC = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const SHA = { 1: "a".repeat(64), 2: "b".repeat(64), 3: "c".repeat(64) };
const kp = KeyPair.fromRandom("ed25519");
const T0 = Date.UTC(2026, 10, 3, 12);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const allow: FirewallResult = { verdict: "allow", risk: 3, technique: "none", reason: "secret reason", firewall_version: "fw-v1", codehash: "local", latency_ms: 4, degraded: false };

type Row = Record<string, any>;
function setup(o: { chain?: Partial<ChainDeps>; deps?: Partial<ServerDeps>; db?: object; tierEnabled?: object } = {}) {
  const clock = { now: T0 };
  const rows = new Map<string, Row>();
  const alerts: [string, any][] = [];
  const logs: [string, any][] = [];
  const keys: { account: string; ip: string; tier: number }[] = [];
  class Spy extends RateLimiter {
    override check(k: Parameters<RateLimiter["check"]>[0], now: number) {
      keys.push(k);
      return super.check(k, now);
    }
  }
  const lookups: string[] = [];
  const chain: ChainDeps = {
    release: async () => ({ nearTx: "NEARTX", chainTxid: "BTCTXID" }),
    tierOpen: async () => ({ status: "open", retryAfterS: 0 }),
    wasSigned: async () => false,
    viewAccessKey: async a => (lookups.push(a), true),
    storeSignedTx: async () => {},
    ...o.chain,
  };
  const db = {
    ping: async () => {},
    insertAttempt: async (r: Row) => void rows.set(r.id, { ...r }),
    updateAttempt: async (id: string, p: Row) => void Object.assign(rows.get(id)!, p),
    setStage: async () => true,
    getAttempt: async (id: string) => rows.get(id) ?? null,
    ...o.db,
  };
  const deps: ServerDeps = {
    cfg: {
      network: "testnet", mock: true, btcHrp: "tb", proxySecret: PROXY, sessionSecret: SESSION, siteUrl: "https://site.test", codehash: "local", firewallVersion: "fw-v1", configSha: "f".repeat(64),
      models: { 1: "m", 2: "m", 3: "m" }, tierEnabled: { 1: true, 2: true, 3: true, ...o.tierEnabled }, judgeModel: "j",
    },
    chain,
    db: db as never,
    chat: async (_t, msg) => ({ raw: {}, text: "ok, releasing", toolCalls: msg.includes("PAY") ? [{ name: "release_funds", args: { recipient: BTC } }] : [] }),
    arenaFirewall: async () => allow,
    attest: async () => ({ sha256: "d".repeat(64), modelId: "m" }),
    promptSha: SHA,
    firewall: { judge: async () => ({ risk: 5, technique: "none", reason: "fine" }), keys: async () => false, limiter: new SlidingWindow(), budget: makeBudget({ counter: memoryCounter(), clock: () => clock.now }), sign: () => new Uint8Array(64), signer: "agent.test" },
    limiter: new Spy(),
    alert: (k, x) => void alerts.push([k, x]),
    log: (e, x) => void logs.push([e, x]),
    clock: () => clock.now,
    ...o.deps,
  };
  const s = makeServer(deps);
  const proxy = { "x-bulkhead-proxy-secret": PROXY, "x-real-ip": "203.0.113.7" };
  const post = (path: string, body: unknown, headers: Record<string, string> = proxy) =>
    s.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  // same format the server issues: account|exp|hmac(account|exp)
  const sessionFor = (account: string, exp = Math.floor(clock.now / 1000) + 7200) => `${account}|${exp}|${createHmac("sha256", SESSION).update(`${account}|${exp}`).digest("hex")}`;
  const get = (path: string, headers: Record<string, string> = proxy) => s.app.request(path, { headers });
  const attempt = (over: Row = {}, headers?: Record<string, string>) => post("/attempt", { session: sessionFor("alice.testnet"), tier: 1, message: "PAY me", payout_address: BTC, consent_version: "v1", ...over }, headers);
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await get(`/attempt/${id}`);
      const j: any = await r.json();
      if (j.result) return j;
      await Bun.sleep(1);
    }
    throw new Error("attempt never finished");
  };
  const go = async (over: Row = {}) => {
    const r = await attempt(over);
    expect(r.status).toBe(202);
    return settle(((await r.json()) as any).attempt_id);
  };
  return { ...s, post, get, attempt, settle, go, sessionFor, clock, rows, alerts, logs, keys, lookups, deps };
}
const err = async (r: Response) => ((await r.json()) as any).error;
const loginMsg = (now: number, over: Row = {}) => {
  const nonce = makeNonce(now);
  return { accountId: "alice.testnet", publicKey: kp.getPublicKey().toString(), signature: b64(kp.sign(nep413Hash({ message: LOGIN_MESSAGE, nonce, recipient: LOGIN_RECIPIENT })).signature), message: LOGIN_MESSAGE, nonce: b64(nonce), recipient: LOGIN_RECIPIENT, ...over };
};

describe("simple routes", () => {
  test("/health and /attestation", async () => {
    const s = setup();
    expect(await (await s.app.request("/health")).json()).toEqual({ ok: true, mock: true });
    const a: any = await (await s.get("/attestation")).json();
    expect(a).toMatchObject({ codehash: "local", checksum: "f".repeat(64), prompt_sha256: SHA, models: { 1: "m", 2: "m", 3: "m" }, firewall_version: "fw-v1" });
    expect(a.verification.not_verified.length).toBeGreaterThan(0);
  });
  test("unknown route is a 404 envelope with docs_url", async () => {
    const e = await err(await setup().app.request("/nope"));
    expect(e).toMatchObject({ code: "not_found", docs_url: "https://site.test/firewall#errors-not_found" });
  });
  test("/v1/check errors get docs_url too, and the route is mounted", async () => {
    const s = setup();
    const r = await s.post("/v1/check", { messages: [] }, {});
    expect(r.status).toBe(401);
    expect((await err(r)).docs_url).toBe("https://site.test/firewall#errors-missing_api_key");
  });
  test("an oversized body is 413 before any work", async () => {
    const s = setup();
    const r = await s.attempt({ message: "x".repeat(20_000) });
    expect(r.status).toBe(413);
    expect((await err(r)).code).toBe("body_too_large");
    expect((await s.post("/session", "x".repeat(20_000))).status).toBe(413);
  });
});

describe("POST /session", () => {
  test("a valid login returns a session that /attempt accepts", async () => {
    const s = setup();
    const r = await s.post("/session", { nep413: loginMsg(T0) });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.expires_at).toBe(new Date(T0 + 7200_000).toISOString());
    expect((await s.attempt({ session: j.session })).status).toBe(202);
    expect(s.keys[0]!.account).toBe("alice.testnet"); // the account bound to the session
  });
  test("failure reasons are 401 envelopes", async () => {
    const s = setup();
    for (const [over, code] of [[{ signature: b64(new Uint8Array(64)) }, "bad_sig"], [{ recipient: "elsewhere" }, "bad_recipient"]] as const) {
      const r = await s.post("/session", { nep413: loginMsg(T0, over) });
      expect(r.status).toBe(401);
      expect((await err(r)).code).toBe(code);
    }
    const expired = await s.post("/session", { nep413: loginMsg(T0 - 400_000) });
    expect((await err(expired)).code).toBe("expired");
    const good = loginMsg(T0);
    expect((await s.post("/session", { nep413: good })).status).toBe(200);
    expect((await err(await s.post("/session", { nep413: good }))).code).toBe("replay");
  });
  test("a key that is not on the account is key_not_on_account", async () => {
    const s = setup({ chain: { viewAccessKey: async () => false } });
    expect((await err(await s.post("/session", { nep413: loginMsg(T0) }))).code).toBe("key_not_on_account");
  });
  test("an RPC failure is 503, never key_not_on_account, and the nonce stays usable", async () => {
    let down = true;
    const s = setup({ chain: { viewAccessKey: async () => { if (down) throw new Error("rpc"); return true; } } });
    const m = loginMsg(T0);
    const r = await s.post("/session", { nep413: m });
    expect(r.status).toBe(503);
    expect((await err(r)).code).toBe("rpc_unavailable");
    down = false;
    expect((await s.post("/session", { nep413: m })).status).toBe(200);
  });
  test("per-IP limit applies before any verification or RPC call (E22)", async () => {
    const s = setup();
    for (let i = 0; i < 10; i++) expect((await s.post("/session", { nep413: loginMsg(T0) })).status).toBe(200);
    const r = await s.post("/session", { nep413: loginMsg(T0) });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await err(await s.post("/session", { nep413: loginMsg(T0) }))).toMatchObject({ code: "rate_limited", rule: "ip" });
    expect(s.lookups.length).toBe(10);
    expect((await s.post("/session", { nep413: loginMsg(T0) }, { ...{ "x-bulkhead-proxy-secret": PROXY }, "x-real-ip": "198.51.100.9" })).status).toBe(200); // another IP is its own bucket
  });
  test("needs the proxy secret and a valid x-real-ip; bad bodies are 400", async () => {
    const s = setup();
    expect((await s.post("/session", { nep413: loginMsg(T0) }, { "x-real-ip": "203.0.113.7" })).status).toBe(403);
    expect((await s.post("/session", { nep413: loginMsg(T0) }, { "x-bulkhead-proxy-secret": PROXY })).status).toBe(400);
    expect((await err(await s.post("/session", "not json"))).code).toBe("bad_request");
    expect((await err(await s.post("/session", { nep413: "x" }))).code).toBe("bad_request");
  });
});

describe("viewAccessKey (E22: FullAccess only)", () => {
  const rpc = (answer: unknown, status = 200) => makeViewAccessKey({ fetch: (async () => new Response(JSON.stringify(answer), { status })) as never, rpcUrl: "https://rpc.test" });
  test("FullAccess passes; FunctionCall and a missing key do not", async () => {
    expect(await rpc({ result: { permission: "FullAccess", nonce: 1 } })("a.near", "ed25519:k")).toBe(true);
    expect(await rpc({ result: { permission: { FunctionCall: { receiver_id: "x", method_names: [], allowance: "1" } }, nonce: 1 } })("a.near", "ed25519:k")).toBe(false);
    expect(await rpc({ error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } })("a.near", "ed25519:k")).toBe(false);
    expect(await rpc({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } })("a.near", "ed25519:k")).toBe(false);
    expect(await rpc({ result: { error: "access key ed25519:k does not exist while viewing" } })("a.near", "ed25519:k")).toBe(false);
  });
  test("an RPC failure, a bad answer or a stall throws", async () => {
    await expect(rpc({}, 502)("a.near", "k")).rejects.toThrow();
    await expect(rpc({ error: { cause: { name: "INTERNAL_ERROR" } } })("a.near", "k")).rejects.toThrow();
    await expect(rpc({ nothing: 1 })("a.near", "k")).rejects.toThrow();
    const stalled = makeViewAccessKey({ fetch: ((_u: string, i: RequestInit) => new Promise((_r, rej) => i.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as never, rpcUrl: "https://rpc.test", timeoutMs: 20 });
    await expect(stalled("a.near", "k")).rejects.toThrow();
  });
});

describe("POST /attempt: rejected before the pipeline", () => {
  test("403 without the proxy secret, and a spoofed x-real-ip is not believed or counted", async () => {
    const s = setup();
    for (const h of [{} as Record<string, string>, { "x-real-ip": "203.0.113.7" }, { "x-bulkhead-proxy-secret": "wrong".repeat(8), "x-real-ip": "203.0.113.7" }]) {
      const r = await s.attempt({}, h);
      expect(r.status).toBe(403);
      expect((await err(r)).code).toBe("proxy_secret_missing");
    }
    expect(s.keys.length).toBe(0);
    expect((await err(await s.attempt({}, { "x-bulkhead-proxy-secret": PROXY }))).code).toBe("bad_client_ip");
    expect((await err(await s.attempt({}, { "x-bulkhead-proxy-secret": PROXY, "x-real-ip": "not-an-ip" }))).code).toBe("bad_client_ip");
  });
  test("IPv6 clients are keyed by /64", async () => {
    const s = setup();
    for (const ip of ["2001:db8:1:2:aaaa::1", "2001:DB8:1:2:bbbb:0:0:2", "::ffff:203.0.113.9"]) await s.attempt({ session: s.sessionFor(`u${s.keys.length}.testnet`) }, { ...{ "x-bulkhead-proxy-secret": PROXY }, "x-real-ip": ip });
    expect(s.keys.map(k => k.ip)).toEqual(["2001:0db8:0001:0002::/64", "2001:0db8:0001:0002::/64", "203.0.113.9"]);
  });
  test("session problems: missing, tampered, expired, someone else's", async () => {
    const s = setup();
    const ok = s.sessionFor("alice.testnet");
    for (const session of [undefined, "", "junk", ok.replace("alice", "bob"), ok.slice(0, -1) + "0", s.sessionFor("alice.testnet", Math.floor(T0 / 1000) - 1), `${ok}|x`]) {
      const r = await s.attempt({ session });
      expect(r.status).toBe(session === undefined ? 400 : 401);
      if (session !== undefined) expect((await err(r)).code).toBe("session_invalid");
    }
    const live = s.sessionFor("alice.testnet");
    s.clock.now += 7200_001;
    expect((await err(await s.attempt({ session: live }))).code).toBe("session_invalid");
    expect(s.keys.length).toBe(0); // no slot was touched
  });
  test("bad tier, checked at runtime", async () => {
    const s = setup();
    for (const tier of ["1", 0, 4, 1.5, null, undefined, [1], {}]) expect((await err(await s.attempt({ tier }))).code).toBe("bad_tier");
  });
  test("message_too_long carries the full envelope and costs nothing", async () => {
    const s = setup();
    const r = await s.attempt({ message: "x".repeat(2001) });
    expect(r.status).toBe(400);
    expect(await err(r)).toMatchObject({ code: "message_too_long", message: expect.any(String), fix: expect.any(String), docs_url: "https://site.test/firewall#errors-message_too_long" });
    expect(s.keys.length).toBe(0);
  });
  test("consent_required, bad_payout_address (BTC, EVM, wrong chain), bad_request", async () => {
    const s = setup();
    expect((await err(await s.attempt({ consent_version: "" }))).code).toBe("consent_required");
    expect((await err(await s.attempt({ consent_version: "bad value!" }))).code).toBe("consent_required");
    expect((await err(await s.attempt({ payout_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }))).code).toBe("bad_payout_address"); // mainnet on a testnet agent
    expect((await err(await s.attempt({ payout_address: EVM }))).code).toBe("bad_payout_address"); // tier 1 is Bitcoin
    expect((await err(await s.attempt({ tier: 2, payout_address: BTC }))).code).toBe("bad_payout_address");
    expect((await err(await s.attempt({ message: 5 }))).code).toBe("bad_request");
    expect((await err(await s.post("/attempt", "[]"))).code).toBe("bad_request");
    expect(s.keys.length).toBe(0);
  });
  test("a disabled tier is tier_closed", async () => {
    const s = setup({ tierEnabled: { 2: false } });
    const r = await s.attempt({ tier: 2, payout_address: EVM });
    expect(r.status).toBe(409);
    expect((await err(r)).code).toBe("tier_closed");
  });
  test("a second attempt from the same account and tier is 429 with Retry-After and retry_after_s", async () => {
    const s = setup();
    await s.go();
    const r = await s.attempt();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await err(r)).toMatchObject({ code: "rate_limited", rule: "account", retry_after_s: expect.any(Number) });
    expect((await s.attempt({ tier: 2, payout_address: EVM })).status).toBe(202); // another tier is its own slot
  });
  test("503 db_unavailable when the ping fails, and the slot is refunded", async () => {
    let up = false;
    const s = setup({ db: { ping: async () => { if (!up) throw new Error("down"); } } });
    const r = await s.attempt();
    expect(r.status).toBe(503);
    expect((await err(r)).code).toBe("db_unavailable");
    up = true;
    expect((await s.attempt()).status).toBe(202);
  });
  test("409 tier_closed and tier_cooling refund; a state read failure is 503", async () => {
    let st: any = { status: "releasing", retryAfterS: 0 };
    const s = setup({ chain: { tierOpen: async () => { if (st === "boom") throw new Error("rpc"); return st; } } });
    expect((await err(await s.attempt())).code).toBe("tier_closed");
    st = { status: "open", retryAfterS: 90.2 };
    const cool = await s.attempt();
    expect(cool.status).toBe(409);
    expect(cool.headers.get("retry-after")).toBe("91");
    expect(await err(cool)).toMatchObject({ code: "tier_cooling", retry_after_s: 91 });
    st = "boom";
    expect((await err(await s.attempt())).code).toBe("chain_unavailable");
    st = { status: "open", retryAfterS: 0 };
    expect((await s.attempt()).status).toBe(202); // every refusal above gave its slot back
  });
});

describe("pipeline through the server", () => {
  test("202, then GET reaches done with snake_case, and the attempt id is the pipeline's", async () => {
    const id = ulid();
    const s = setup({ deps: { newId: () => id } });
    const r = await s.attempt();
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ attempt_id: id });
    const j = await s.settle(id);
    expect(j.stage).toBe("done");
    expect(j.result).toEqual({ id, outcome: "drained", reply: "ok, releasing", txs: { near_tx: "NEARTX", chain_txid: "BTCTXID" } });
    expect(s.alerts.map(a => a[0])).toEqual(["drained"]);
    expect(s.rows.get(id)!.account).toBe("alice.testnet"); // the db layer hashes it; the pipeline hands over the raw account
  });
  test("a refusal is a result too, tier 3 shows both firewall verdicts and no reason", async () => {
    const s = setup();
    const refused: any = await s.go({ message: "hello" });
    expect(refused.result).toMatchObject({ outcome: "refused" });
    const t3: any = await s.go({ tier: 3, session: s.sessionFor("bob.testnet") });
    expect(t3.result.firewall.a).toEqual({ verdict: "allow", risk: 3, technique: "none", firewall_version: "fw-v1", codehash: "local", latency_ms: 4, degraded: false });
    expect(JSON.stringify(t3)).not.toContain("secret reason");
  });
  test("GET unknown id and a malformed id are 404", async () => {
    const s = setup();
    for (const id of [ulid(), "nope"]) {
      const r = await s.get(`/attempt/${id}`);
      expect(r.status).toBe(404);
      expect((await err(r)).code).toBe("attempt_not_found");
    }
  });
  test("an id this process does not hold falls back to the database, without reasons (M10)", async () => {
    const id = ulid();
    const s = setup({
      db: { getAttempt: async (i: string) => (i === id ? { id, tier: 3, stage: "done", outcome: "blocked_b", reply: "stopped", fw_a: { verdict: "allow", reason: "r1", risk: 1 }, fw_b: { verdict: "block", reason: "r2", risk: 90 }, near_tx: null, chain_txid: null } : null) },
    });
    const j: any = await (await s.get(`/attempt/${id}`)).json();
    expect(j).toEqual({ stage: "done", result: { id, outcome: "blocked_b", reply: "stopped", firewall: { a: { verdict: "allow", risk: 1 }, b: { verdict: "block", risk: 90 } } } });
    const mid: any = await (await (() => { const w = setup({ db: { getAttempt: async () => ({ id, tier: 1, stage: "signing", outcome: "releasing", reply: "" }) } }); return w.get(`/attempt/${id}`); })()).json();
    expect(mid).toEqual({ stage: "signing" });
    const down = setup({ db: { getAttempt: async () => { throw new Error("x"); } } });
    expect((await err(await down.get(`/attempt/${id}`))).code).toBe("db_unavailable");
  });
  test("attestation failure: result is 503 attestation_unavailable, the hit is refunded, and an alert goes out", async () => {
    const s = setup({ deps: { attest: async () => { throw new AttestError("nonce_mismatch"); } } });
    const j: any = await s.go();
    expect(j.result.error).toMatchObject({ code: "attestation_unavailable", docs_url: expect.any(String) });
    expect(s.alerts).toEqual([["attestation_failure", { tier: 1, code: "nonce_mismatch" }]]);
    expect((await s.attempt()).status).toBe(202); // refunded
  });
  test("llm, spend cap and degraded firewall are 503 results and refund", async () => {
    const { LlmUnavailableError, SpendCapError } = await import("../src/pipeline");
    for (const [code, mk] of [["llm_unavailable", () => new LlmUnavailableError()], ["spend_cap", () => new SpendCapError()]] as const) {
      const s = setup({ deps: { chat: async () => { throw mk(); } } });
      expect((await s.go() as any).result.error.code).toBe(code);
      expect((await s.attempt()).status).toBe(202);
    }
    const s = setup({ deps: { arenaFirewall: async () => ({ ...allow, degraded: true }) } });
    expect(((await s.go({ tier: 3 })) as any).result.error.code).toBe("firewall_degraded");
  });
  test("won_race_lost is a 409 result with the reply, and refunds", async () => {
    let n = 0;
    const s = setup({ chain: { tierOpen: async () => (++n >= 3 ? { status: "releasing", retryAfterS: 0 } : { status: "open", retryAfterS: 0 }) } });
    const j: any = await s.go();
    expect(j.result.error).toMatchObject({ code: "won_race_lost", reply: "ok, releasing" });
    n = 0;
    expect((await s.attempt()).status).toBe(202);
  });
  test("release_failed: refund, one alert naming the contract error, tier unlocked", async () => {
    const s = setup({ chain: { release: async () => { throw new Error("ERR_FEE_TOO_HIGH: fee 5 over cap") } } });
    const j: any = await s.go();
    expect(j.result.outcome).toBe("release_failed");
    expect(s.alerts).toEqual([["release_failed", { attempt_id: j.result.id, tier: 1, code: "ERR_FEE_TOO_HIGH", error_class: "Error" }]]);
    expect(s.locks.has(1)).toBe(false);
    expect((await s.attempt()).status).toBe(202);
  });
  test("a Base release with no gas is release_failed and alerts once", async () => {
    const noGas = Object.assign(new Error("tier address holds no ETH for gas"), { name: "NoGasFundsError" });
    const s = setup({ chain: { release: async () => { throw noGas; } }, deps: { chat: async () => ({ raw: {}, text: "sure", toolCalls: [{ name: "release_funds", args: { recipient: EVM } }] }) } });
    const j: any = await s.go({ tier: 2, payout_address: EVM });
    expect(j.result.outcome).toBe("release_failed");
    expect(s.alerts.length).toBe(1);
    expect(s.alerts[0]![1]).toMatchObject({ code: "NoGasFundsError", tier: 2 });
  });
  test("signed but not broadcast: alert, no refund, the lock stays until onSettled", async () => {
    const s = setup({ chain: { release: async () => { throw new BroadcastFailedError("NEARTX"); } } });
    const j: any = await s.go();
    expect(j.result).toMatchObject({ outcome: "signed_pending_broadcast", txs: { near_tx: "NEARTX" } });
    expect(s.alerts.map(a => a[0])).toEqual(["signed_pending_broadcast"]);
    expect(s.locks.has(1)).toBe(true);
    s.clock.now += 700_000; // past the account window
    expect((await err(await s.attempt())).code).toBe("tier_closed");
    s.onSettled(1);
    expect((await s.attempt()).status).toBe(202);
  });
  test("an unexpected failure is 500 internal naming the attempt id, and is logged", async () => {
    const id = ulid();
    const s = setup({ deps: { newId: () => id, attest: async () => ({ sha256: "d".repeat(64), modelId: "m" }) }, db: { insertAttempt: async () => { throw new Error("convex exploded"); } } });
    const j: any = await s.go();
    expect(j.result.error.code).toBe("internal");
    expect(j.result.error.message).toContain(id);
    expect(JSON.stringify(j)).not.toContain("convex exploded");
    expect(s.logs[0]![0]).toBe("attempt_failed");
  });
  test("judge degraded more than 5 times in 10 minutes alerts once", async () => {
    const s = setup({ deps: { arenaFirewall: async () => ({ ...allow, degraded: true }) } });
    for (let i = 0; i < 8; i++) await s.go({ tier: 3, session: s.sessionFor(`u${i}.testnet`) });
    expect(s.alerts.filter(a => a[0] === "judge_degraded").length).toBe(1);
    expect(s.alerts.find(a => a[0] === "judge_degraded")![1].count).toBe(6);
  });
});

describe("makeAlert", () => {
  test("posts JSON to the webhook, and is a no-op when unset or broken", async () => {
    const seen: any[] = [];
    const a = makeAlert({ fetch: (async (u: string, i: RequestInit) => (seen.push([u, JSON.parse(String(i.body))]), new Response("ok"))) as never, url: "https://hook.test/x", clock: () => T0 });
    a("drained", { tier: 1 });
    await Bun.sleep(5);
    expect(seen).toEqual([["https://hook.test/x", { kind: "drained", details: { tier: 1 }, ts: new Date(T0).toISOString() }]]);
    makeAlert({ fetch: (async () => { throw new Error("x"); }) as never, url: "https://hook.test" })("k", {});
    makeAlert({ fetch: (async () => { throw new Error("must not be called"); }) as never })("k", {});
    await Bun.sleep(5);
  });
});

describe("review fixes", () => {
  test("a secret that matches in characters but not bytes is a 403, not a crash", async () => {
    const s = setup();
    const r = await s.attempt({}, { "x-bulkhead-proxy-secret": "é".repeat(32), "x-real-ip": "203.0.113.7" }); // 32 chars, 64 bytes
    expect(r.status).toBe(403);
    expect((await s.post("/session", {}, { "x-bulkhead-proxy-secret": "é".repeat(32), "x-real-ip": "203.0.113.7" })).status).toBe(403);
  });
  test("a session exp must be a plain number of at most 11 digits", async () => {
    const s = setup();
    for (const exp of ["0", "01" + "9".repeat(9), "1".repeat(12), "-5", "1e10", "+5"]) {
      const session = `alice.testnet|${exp}|${createHmac("sha256", SESSION).update(`alice.testnet|${exp}`).digest("hex")}`; // validly signed
      expect((await err(await s.attempt({ session }))).code).toBe("session_invalid");
    }
  });
  test("/attempt/:id and /attestation need the proxy secret; /health does not", async () => {
    const s = setup();
    for (const path of [`/attempt/${ulid()}`, "/attestation"]) {
      expect((await s.get(path, {})).status).toBe(403);
      expect((await s.get(path, { "x-bulkhead-proxy-secret": "wrong" })).status).toBe(403);
      expect((await err(await s.get(path, {}))).code).toBe("proxy_secret_missing");
    }
    expect((await s.get("/health", {})).status).toBe(200);
  });
  test("/attestation in mock mode claims nothing; otherwise it lists what the code does check", async () => {
    const mock: any = await (await setup().get("/attestation")).json();
    expect(mock.verification).toEqual({ verified: [], not_verified: ["mock mode: no attestation performed"] });
    const base = setup().deps.cfg;
    const live: any = await (await setup({ deps: { cfg: { ...base, mock: false } } }).get("/attestation")).json();
    expect(live.verification.verified).toContain("response_signature_checked_and_recorded_per_attempt");
    expect(live.verification.not_verified.length).toBeGreaterThan(1);
  });
  test("response_verified: false with no model call checked, true when every call of the attempt verified", async () => {
    const info = { id: "c", model: "m", requestHash: "a", responseHash: "b" };
    const none = setup();
    const a: any = await none.go();
    expect(none.rows.get(a.result.id)!.response_verified).toBe(false);
    const good = setup({ deps: { chat: async () => (trackCompletion(async () => true)(info), { raw: {}, text: "ok", toolCalls: [] }) } });
    const g: any = await good.go();
    expect(good.rows.get(g.result.id)!.response_verified).toBe(true);
    const mixed = setup({ deps: { chat: async () => (trackCompletion(async () => true)(info), trackCompletion(async () => false)(info), { raw: {}, text: "ok", toolCalls: [] }) } });
    const m: any = await mixed.go();
    expect(mixed.rows.get(m.result.id)!.response_verified).toBe(false);
    const slow = setup({ deps: { completionWaitMs: 10, chat: async () => (trackCompletion(() => new Promise<boolean>(r => setTimeout(() => r(true), 300)))(info), { raw: {}, text: "ok", toolCalls: [] }) } });
    const t0 = performance.now();
    const sl: any = await slow.go();
    expect(slow.rows.get(sl.result.id)!.response_verified).toBe(false); // not done in time: not claimed
    expect(performance.now() - t0).toBeLessThan(250);
  });
  test("release_failed alerts are throttled to one per code per 10 minutes and carry no error text", async () => {
    const secretUrl = "https://rpc.example/v1/KEY-123";
    const s = setup({ chain: { release: async () => { throw new Error(`fetch failed ${secretUrl} ERR_FEE_TOO_HIGH`); } } });
    await s.go();
    await s.go({ session: s.sessionFor("bob.testnet") });
    expect(s.alerts.length).toBe(1);
    expect(JSON.stringify(s.alerts)).not.toContain("KEY-123");
    expect(s.alerts[0]![1]).toMatchObject({ code: "ERR_FEE_TOO_HIGH", error_class: "Error" });
    s.clock.now += 600_000;
    await s.go({ session: s.sessionFor("carol.testnet") });
    expect(s.alerts.length).toBe(2);
  });
  test("a different release error code alerts immediately", async () => {
    let n = 0;
    const s = setup({ chain: { release: async () => { throw new Error(n++ ? "ERR_PAUSED" : "ERR_FEE_TOO_HIGH"); } } });
    await s.go();
    await s.go({ session: s.sessionFor("bob.testnet") });
    expect(s.alerts.map(a => a[1].code)).toEqual(["ERR_FEE_TOO_HIGH", "ERR_PAUSED"]);
  });
  test("makeAlert scrubs error and message text from any caller's details, and errCode never returns raw text", async () => {
    const seen: any[] = [];
    const a = makeAlert({ fetch: (async (_u: string, i: RequestInit) => (seen.push(JSON.parse(String(i.body))), new Response("ok"))) as never, url: "https://hook.test" });
    a("broadcast_failed_terminal", { attempt_id: "x", error: "HTTP 500 from https://base-mainnet.g.alchemy.com/v2/SECRETKEY ERR_NOT_CONSOLIDATED", message: "also https://x/SECRETKEY" });
    await Bun.sleep(5);
    expect(JSON.stringify(seen)).not.toContain("SECRETKEY");
    expect(seen[0].details).toMatchObject({ attempt_id: "x", error: "ERR_NOT_CONSOLIDATED", message: "unknown" });
    expect(errCode(new Error("https://rpc/SECRETKEY"))).toBe("Error");
    expect(errCode(new AttestError("nonce_mismatch"))).toBe("nonce_mismatch");
  });
});
