import { describe, expect, test } from "bun:test";
import { callAgent, clientIp, proxy } from "./agent";

const SECRET = "test-proxy-secret-9f8e7d";
const env = { AGENT_URL: "http://agent.internal:8080", PROXY_SECRET: SECRET };

// A fake agent that records what it was sent and answers with `answer`.
function fakeAgent(answer: () => Response = () => Response.json({ ok: true })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { calls, f };
}
const sent = (c: { init: RequestInit }) => new Headers(c.init.headers);

describe("proxy", () => {
  test("adds the proxy secret and the client IP on the server side", async () => {
    const a = fakeAgent();
    const req = new Request("http://site/api/attempt", { method: "POST", body: '{"tier":1}', headers: { "x-real-ip": "203.0.113.7" } });
    await proxy(req, "/attempt", { env: { ...env, VERCEL: "1" }, fetch: a.f });
    expect(a.calls[0]!.url).toBe("http://agent.internal:8080/attempt");
    expect(sent(a.calls[0]!).get("x-bulkhead-proxy-secret")).toBe(SECRET);
    expect(sent(a.calls[0]!).get("x-real-ip")).toBe("203.0.113.7");
    expect(a.calls[0]!.init.body).toBe('{"tier":1}');
  });

  test("never forwards a secret, cookie or other header the browser sent", async () => {
    const a = fakeAgent();
    const req = new Request("http://site/api/attempt", {
      method: "POST",
      body: "{}",
      headers: { "x-bulkhead-proxy-secret": "attacker-guess", cookie: "a=b", authorization: "Bearer x", "x-real-ip": "198.51.100.1" },
    });
    await proxy(req, "/attempt", { env, fetch: a.f });
    const h = sent(a.calls[0]!);
    expect(h.get("x-bulkhead-proxy-secret")).toBe(SECRET);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("authorization")).toBeNull();
  });

  test("the response never carries the secret back, and only safe headers pass", async () => {
    const a = fakeAgent(() => new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { "content-type": "application/json", "retry-after": "42", "x-bulkhead-proxy-secret": SECRET, "set-cookie": "x=y" } }));
    const res = await proxy(new Request("http://site/api/attempt", { method: "POST", body: "{}" }), "/attempt", { env, fetch: a.f });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("x-bulkhead-proxy-secret")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).error.code).toBe("rate_limited");
  });

  test("x-firewall-degraded is passed through", async () => {
    const a = fakeAgent(() => new Response("{}", { headers: { "x-firewall-degraded": "1" } }));
    const res = await proxy(new Request("http://site/api/attestation"), "/attestation", { env, fetch: a.f });
    expect(res.headers.get("x-firewall-degraded")).toBe("1");
  });

  test("a body over 16 KiB is refused before it reaches the agent", async () => {
    const a = fakeAgent();
    const res = await proxy(new Request("http://site/api/attempt", { method: "POST", body: "x".repeat(16 * 1024 + 1) }), "/attempt", { env, fetch: a.f });
    expect(res.status).toBe(413);
    expect(a.calls.length).toBe(0);
  });

  test("an unreachable agent is a 503 JSON error, not a crash, and says nothing about the URL", async () => {
    const f = (async () => {
      throw new Error("connect ECONNREFUSED http://agent.internal:8080");
    }) as unknown as typeof fetch;
    const res = await proxy(new Request("http://site/api/attestation"), "/attestation", { env, fetch: f });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("agent_unreachable");
    expect(text).not.toContain("agent.internal");
  });

  test("with no agent configured, nothing is sent and the answer is a 503", async () => {
    const a = fakeAgent();
    const res = await proxy(new Request("http://site/api/attestation"), "/attestation", { env: {}, fetch: a.f });
    expect(res.status).toBe(503);
    expect(a.calls.length).toBe(0);
  });
});

describe("clientIp", () => {
  const h = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.2", "cf-connecting-ip": "192.0.2.9" });
  test("off Vercel and with no trusted header named, no IP is sent, so the agent refuses (fail closed)", () => {
    expect(clientIp(h, {})).toBeNull();
  });
  test("on Vercel, x-real-ip (Vercel overwrites it)", () => {
    expect(clientIp(h, { VERCEL: "1" })).toBe("203.0.113.7");
  });
  test("TRUSTED_IP_HEADER names the one header to believe", () => {
    expect(clientIp(h, { TRUSTED_IP_HEADER: "cf-connecting-ip" })).toBe("192.0.2.9");
    expect(clientIp(h, { TRUSTED_IP_HEADER: "x-real-ip", VERCEL: "1" })).toBe("203.0.113.7");
  });
  test("x-forwarded-for is never used, even when it is the only header", () => {
    const xff = new Headers({ "x-forwarded-for": "198.51.100.2" });
    expect(clientIp(xff, { VERCEL: "1" })).toBeNull();
    expect(clientIp(xff, {})).toBeNull();
  });
  test("the proxy sends no x-real-ip when it cannot trust one", async () => {
    const a = fakeAgent();
    await proxy(new Request("http://site/api/attempt", { method: "POST", body: "{}", headers: { "x-real-ip": "203.0.113.7" } }), "/attempt", { env, fetch: a.f });
    expect(sent(a.calls[0]!).get("x-real-ip")).toBeNull();
  });
});

describe("body cap", () => {
  test("a declared content-length over 16 KiB is refused before the body is read", async () => {
    const a = fakeAgent();
    let read = false;
    const body = new ReadableStream({
      pull(c) {
        read = true;
        c.enqueue(new TextEncoder().encode("{}"));
        c.close();
      },
    }, { highWaterMark: 0 }); // nothing is pulled until someone reads
    const req = new Request("http://site/api/attempt", { method: "POST", body, headers: { "content-length": String(16 * 1024 + 1) }, duplex: "half" } as RequestInit);
    const res = await proxy(req, "/attempt", { env, fetch: a.f });
    expect(res.status).toBe(413);
    expect(read).toBe(false);
    expect(a.calls.length).toBe(0);
  });
});

describe("callAgent", () => {
  test("server-side reads carry the secret too", async () => {
    const a = fakeAgent(() => Response.json({ codehash: "abc" }));
    const r = await callAgent("/attestation", { env, fetch: a.f });
    expect(r.status).toBe(200);
    expect(sent(a.calls[0]!).get("x-bulkhead-proxy-secret")).toBe(SECRET);
  });
});

describe("mock mode", () => {
  test("MOCK_AGENT=1 never calls the agent and serves fixtures", async () => {
    const a = fakeAgent();
    const res = await proxy(new Request("http://site/api/attestation"), "/attestation", { env: { ...env, MOCK_AGENT: "1" }, fetch: a.f });
    expect(a.calls.length).toBe(0);
    expect((await res.json()).codehash).toBeString();
  });

  test("a mock attempt is accepted, moves through stages and ends with its fixture", async () => {
    const m = { env: { MOCK_AGENT: "1" }, now: () => 1_000_000 };
    const body = JSON.stringify({ session: "s", tier: 3, message: "mock:blocked_b", payout_address: "tb1q", consent_version: "v" });
    const post = await proxy(new Request("http://site/api/attempt", { method: "POST", body }), "/attempt", m);
    expect(post.status).toBe(202);
    const { attempt_id } = await post.json();
    const early = await (await proxy(new Request("http://x"), `/attempt/${attempt_id}`, m)).json();
    expect(early.stage).toBe("reading");
    expect(early.result).toBeUndefined();
    const late = await (await proxy(new Request("http://x"), `/attempt/${attempt_id}`, { ...m, now: () => 1_000_000 + 60_000 })).json();
    expect(late.stage).toBe("done");
    expect(late.result.outcome).toBe("blocked_b");
  });

  test("a mock HTTP error fixture answers with its status", async () => {
    const body = JSON.stringify({ session: "s", tier: 1, message: "mock:rate_limited_account", payout_address: "tb1q", consent_version: "v" });
    const res = await proxy(new Request("http://site/api/attempt", { method: "POST", body }), "/attempt", { env: { MOCK_AGENT: "1" } });
    expect(res.status).toBe(429);
    expect((await res.json()).error.rule).toBe("account");
  });

  test("the mock refuses a message over 2000 characters, as the agent does", async () => {
    const body = JSON.stringify({ session: "s", tier: 1, message: "x".repeat(2001), payout_address: "tb1q", consent_version: "v" });
    const res = await proxy(new Request("http://site/api/attempt", { method: "POST", body }), "/attempt", { env: { MOCK_AGENT: "1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("message_too_long");
  });
});
