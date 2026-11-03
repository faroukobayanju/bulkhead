import { describe, expect, spyOn, test } from "bun:test";
import { main as latency, percentile } from "../../scripts/latency";
import { main as smoke, ATTACKS, BENIGN } from "../../scripts/judge-smoke";

const KEY = "sk-test-SECRET-smoke-key";
const noNetwork = () => {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(String(url));
    throw new Error("no network in tests");
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};
const lines = () => {
  const out: string[] = [];
  return { out, log: (s: string) => void out.push(s), text: () => out.join("\n") };
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("percentile", () => {
  test("nearest rank", () => {
    const xs = Array.from({ length: 100 }, (_, i) => 100 - i); // unsorted 100..1
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.95)).toBe(95);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2], 0.5)).toBe(1);
  });
});

describe("judge-smoke refuses to run", () => {
  const cases: [string, string[], Record<string, string>][] = [
    ["without LIVE", ["--max-usd", "1"], { NEARAI_API_KEY: KEY }],
    ["with LIVE=0", ["--max-usd", "1"], { LIVE: "0", NEARAI_API_KEY: KEY }],
    ["with LIVE=true", ["--max-usd", "1"], { LIVE: "true", NEARAI_API_KEY: KEY }],
    ["without --max-usd", [], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd and no value", ["--max-usd"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd abc", ["--max-usd", "abc"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd 0", ["--max-usd", "0"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd -1", ["--max-usd", "-1"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd NaN", ["--max-usd", "NaN"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd Infinity", ["--max-usd", "Infinity"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["without NEARAI_API_KEY", ["--max-usd", "1"], { LIVE: "1" }],
    ["with the key on the command line instead of the environment", ["--max-usd", "1", "--api-key", KEY], { LIVE: "1" }],
  ];
  test.each(cases)("%s: exits non-zero without a network call and never prints the key", async (_, argv, env) => {
    const net = noNetwork();
    const l = lines();
    expect(await smoke(argv, env, { fetch: net.fetch, log: l.log })).toBe(2);
    expect(net.calls).toEqual([]);
    expect(l.out.length).toBeGreaterThan(0);
    expect(l.text()).not.toContain(KEY);
  });

  test("the message says what to set", async () => {
    const l = lines();
    await smoke([], {}, { fetch: noNetwork().fetch, log: l.log });
    expect(l.text()).toContain("LIVE=1");
    await smoke([], { LIVE: "1" }, { fetch: noNetwork().fetch, log: l.log });
    expect(l.text()).toContain("--max-usd");
  });
});

// A fake NEAR AI: the judge reply depends on whether the message looks like one of the inline attacks.
function fakeNearAI(opts: { perCall?: { prompt_tokens: number; completion_tokens: number } | null; status?: number } = {}) {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body, auth: (init.headers as Record<string, string>).authorization });
    if (opts.status) return json({ error: "x" }, opts.status);
    const user = JSON.parse(body.messages[1].content);
    const attack = ATTACKS.includes(user.messages[0].content);
    return json({
      choices: [{ message: { content: JSON.stringify({ risk: attack ? 90 : 3, technique: attack ? "override" : "none", reason: "fake" }) }, finish_reason: "stop" }],
      usage: opts.perCall === null ? undefined : (opts.perCall ?? { prompt_tokens: 500, completion_tokens: 50 }),
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("judge-smoke with a fake NEAR AI", () => {
  test("has 10 attack and 10 benign messages", () => {
    expect(ATTACKS.length).toBe(10);
    expect(BENIGN.length).toBe(10);
    expect(new Set([...ATTACKS, ...BENIGN]).size).toBe(20);
  });

  test("rates all 20, prints verdict, risk, latency and finish_reason per message, then counts, p95 and spend", async () => {
    const net = fakeNearAI();
    const l = lines();
    let t = 0;
    const code = await smoke(["--max-usd", "1"], { LIVE: "1", NEARAI_API_KEY: KEY }, { fetch: net.fetch, log: l.log, now: () => (t += 100) });
    expect(code).toBe(0);
    expect(net.calls.length).toBe(20);
    expect(net.calls[0].url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(net.calls[0].auth).toBe(`Bearer ${KEY}`);
    expect(net.calls[0].body).toMatchObject({ model: "Qwen/Qwen3.8-27B", temperature: 0, max_tokens: 400 });
    const text = l.text();
    expect(l.out.filter(s => /^#\d\d /.test(s)).length).toBe(20);
    expect(text).toMatch(/#01 attack\s+block\s+risk 90\s+override\s+100ms\s+stop/);
    expect(text).toMatch(/#11 benign\s+allow\s+risk 3\s/);
    expect(text).toContain("attacks blocked 10/10");
    expect(text).toContain("benign allowed 10/10");
    expect(text).toContain("p95 100 ms");
    // 500 prompt tokens at 0.04 and 50 completion tokens at 1.35 micro-USD each, rounded up per call, 20 calls
    expect(text).toContain(`estimated spend $${((20 * Math.ceil(500 * 0.04 + 50 * 1.35)) / 1e6).toFixed(6)}`);
    expect(text).not.toContain(KEY);
  });

  test("stops once estimated spend reaches --max-usd", async () => {
    // each call costs 500 * 0.04 + 100000 * 1.35 = 135,020 micro-USD; the limit is 200,000
    const net = fakeNearAI({ perCall: { prompt_tokens: 500, completion_tokens: 100_000 } });
    const l = lines();
    const code = await smoke(["--max-usd", "0.2"], { LIVE: "1", NEARAI_API_KEY: KEY }, { fetch: net.fetch, log: l.log });
    expect(net.calls.length).toBe(2);
    expect(l.text()).toContain("stopping: estimated spend reached --max-usd 0.2");
    expect(l.out.filter(s => /^#\d\d /.test(s)).length).toBe(2);
    expect(code).toBe(0);
  });

  test("the spend key uses one clock value for the whole run, so midnight UTC cannot reset the count", async () => {
    let day = Date.UTC(2026, 10, 2, 23, 59, 59);
    const now = spyOn(Date, "now").mockImplementation(() => (day += 86_400_000));
    try {
      const net = fakeNearAI({ perCall: { prompt_tokens: 500, completion_tokens: 100_000 } });
      const l = lines();
      await smoke(["--max-usd", "0.2"], { LIVE: "1", NEARAI_API_KEY: KEY }, { fetch: net.fetch, log: l.log });
      expect(net.calls.length).toBe(2);
      expect(l.text()).toContain("stopping: estimated spend reached --max-usd 0.2");
    } finally {
      now.mockRestore();
    }
  });

  test("a call refused because its worst case no longer fits stops the run without counting an error", async () => {
    const net = fakeNearAI({ perCall: { prompt_tokens: 500, completion_tokens: 100_000 } });
    const l = lines();
    // one call settles at 135,020 micro-USD; of the 135,500 allowed, 480 are left, and another call's worst case is about 600
    const code = await smoke(["--max-usd", "0.1355"], { LIVE: "1", NEARAI_API_KEY: KEY }, { fetch: net.fetch, log: l.log });
    expect(code).toBe(0);
    expect(net.calls.length).toBe(1);
    expect(l.text()).toContain("stopping: another call could pass --max-usd 0.1355");
    expect(l.text()).toContain("errors 0");
  });

  test("a call that fails is shown, counted, and makes the exit code 1", async () => {
    const net = fakeNearAI({ status: 503 });
    const l = lines();
    const code = await smoke(["--max-usd", "1"], { LIVE: "1", NEARAI_API_KEY: KEY }, { fetch: net.fetch, log: l.log });
    expect(code).toBe(1);
    expect(l.text()).toContain("error http");
    expect(l.text()).toContain("errors 20");
    expect(l.text()).not.toContain(KEY);
  });

  test("with no usage in the reply the worst case is charged, so the limit still bites", async () => {
    const net = fakeNearAI({ perCall: null });
    const l = lines();
    // worst case per call is about 400 * 1.35 + prompt bytes * 0.04 = about 600 micro-USD; 0.001 USD is 1000
    await smoke(["--max-usd", "0.001"], { LIVE: "1", NEARAI_API_KEY: KEY }, { fetch: net.fetch, log: l.log });
    expect(net.calls.length).toBeLessThan(5);
    expect(l.text()).toContain("stopping");
  });
});

describe("latency script", () => {
  const BENIGN_FILE = Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: `b${i}`, message: `hello dragon ${i}` })).join("\n") + "\n";
  const env = { BULKHEAD_KEY: KEY };
  function rig(ms: number | ((i: number) => number), respond: (i: number) => Response = () => json({ verdict: "allow" })) {
    const clock = { t: 0 };
    const sent: { url: string; key: string; body: any }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const sleeps: number[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const i = sent.length;
      sent.push({ url, key: (init.headers as Record<string, string>)["x-api-key"]!, body: JSON.parse(init.body as string) });
      clock.t += typeof ms === "function" ? ms(i) : ms;
      inFlight--;
      return respond(i);
    }) as unknown as typeof globalThis.fetch;
    const io = { fetch, now: () => clock.t, sleep: async (n: number) => void (sleeps.push(n), (clock.t += n)), read: () => BENIGN_FILE, log: lines() };
    return { io: { ...io, log: io.log.log }, sent, sleeps, text: io.log.text, maxInFlight: () => maxInFlight, clock };
  }

  test("sends 100 sequential requests from the benign file and passes when p95 is under 4000 ms", async () => {
    const r = rig(1800);
    expect(await latency(["https://agent.example"], env, r.io)).toBe(0);
    expect(r.sent.length).toBe(100);
    expect(r.maxInFlight()).toBe(1);
    expect(r.sent[0]).toEqual({ url: "https://agent.example/v1/check", key: KEY, body: { messages: [{ role: "user", content: "hello dragon 0" }] } });
    expect(r.sent[30]!.body.messages[0].content).toBe("hello dragon 0"); // the 30-line file is cycled
    expect(r.text()).toContain("p50 1800 ms, p95 1800 ms");
    expect(r.text()).not.toContain(KEY);
  });

  test("fails when p95 is 4000 ms or more, passes just under", async () => {
    // nearest-rank p95 of 100 is the 95th fastest: it is a slow one once 6 requests are slow
    expect(await latency(["https://a.test"], env, rig(i => (i < 6 ? 4000 : 500)).io)).toBe(1);
    expect(await latency(["https://a.test"], env, rig(i => (i < 6 ? 3999 : 500)).io)).toBe(0);
    // 5 slow ones leave p95 at the fast value
    expect(await latency(["https://a.test"], env, rig(i => (i < 5 ? 9000 : 500)).io)).toBe(0);
  });

  test("keeps under the 60 a minute key limit by spacing request starts at least 1.1 s", async () => {
    const r = rig(100);
    await latency(["https://a.test"], env, r.io);
    expect(r.sleeps.length).toBe(99);
    expect(r.sleeps.every(s => s === 1000)).toBe(true);
  });

  test("a non-200 stops the run with exit 1", async () => {
    const r = rig(10, i => (i === 3 ? json({ error: { code: "rate_limited" } }, 429) : json({})));
    expect(await latency(["https://a.test"], env, r.io)).toBe(1);
    expect(r.sent.length).toBe(4);
    expect(r.text()).toContain("429");
  });

  test("counts degraded answers", async () => {
    const r = rig(10, i => json({}, 200, i < 3 ? { "x-firewall-degraded": "1" } : {}));
    await latency(["https://a.test"], env, r.io);
    expect(r.text()).toContain("degraded 3");
  });

  test.each([
    ["no URL", [], env],
    ["no BULKHEAD_KEY", ["https://a.test"], {}],
  ])("%s exits 2 without a request", async (_, argv, e) => {
    const r = rig(1);
    expect(await latency(argv as string[], e, r.io)).toBe(2);
    expect(r.sent.length).toBe(0);
  });

  test("an unreadable or empty benign file exits 2", async () => {
    const r = rig(1);
    expect(await latency(["https://a.test"], env, { ...r.io, read: () => { throw new Error("ENOENT"); } })).toBe(2);
    expect(await latency(["https://a.test"], env, { ...r.io, read: () => "\n\n" })).toBe(2);
    expect(r.sent.length).toBe(0);
  });
});
