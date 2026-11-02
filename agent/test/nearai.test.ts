import { afterEach, describe, expect, test } from "bun:test";
import agentConfig from "../config/agent.json";
import { memoryCounter, utcDay } from "../src/counter";
import { dailyLimitUsd, makeNearAI, NearAIError, type ChatRequest } from "../src/nearai";
import { trackTimers } from "./timers";

const KEY = "sk-test-SECRET-key-123";
const MSGS = [{ role: "user", content: "hi" }];
const bytes = (m: unknown) => Buffer.byteLength(JSON.stringify(m));
const reply = (usage: unknown = { prompt_tokens: 1000, completion_tokens: 500 }, content: string | null = "hello") => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  ...(usage ? { usage } : {}),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: "m", messages: MSGS, max_tokens: 400, timeoutMs: 1000, ...over });

type Call = { url: string; init: RequestInit };
// Prices of 1 and 2 micro-USD per token make every cost an exact integer. 1000 prompt + 500 completion tokens cost 2000.
function setup(over: Record<string, unknown> = {}) {
  const counter = memoryCounter();
  const calls: Call[] = [];
  const alerts: { day: string; spentUsd: number; limitUsd: number }[] = [];
  const clock = { now: T0 };
  const fetch = async (url: string, init: RequestInit) => (calls.push({ url, init }), json(reply()));
  const ai = makeNearAI({
    fetch: fetch as never,
    apiKey: KEY,
    base: "https://nearai.test/v1",
    prices: { m: { in: 1, out: 2 } },
    counter,
    clock: () => clock.now,
    dailyUsd: 0.01, // 10_000 micro-USD
    onAlert: a => void alerts.push(a),
    ...over,
  });
  const spent = (ms = clock.now) => counter.get(`nearai:spend:${utcDay(ms)}`);
  return { ai, counter, calls, alerts, clock, spent };
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as NearAIError;
  }
  throw new Error("expected a rejection");
};

describe("spend accounting", () => {
  test("adds usage times the price table to the day's spend", async () => {
    const s = setup();
    await s.ai.chat(req());
    expect(await s.spent()).toBe(2000);
    await s.ai.chat(req());
    expect(await s.spent()).toBe(4000);
  });

  test("spend is keyed by UTC day", async () => {
    const s = setup();
    s.clock.now = Date.UTC(2026, 10, 2, 23, 59, 59, 999);
    await s.ai.chat(req());
    s.clock.now = Date.UTC(2026, 10, 3, 0, 0, 0, 0);
    await s.ai.chat(req());
    expect(await s.spent(Date.UTC(2026, 10, 2))).toBe(2000);
    expect(await s.spent(Date.UTC(2026, 10, 3))).toBe(2000);
  });

  test("missing usage counts max_tokens (and the prompt bytes) as worst case", async () => {
    const s = setup({ fetch: async () => json(reply(null)) });
    await s.ai.chat(req({ max_tokens: 400 }));
    expect(await s.spent()).toBe(bytes(MSGS) * 1 + 400 * 2);
  });

  test.each([
    ["not an object", "lots"],
    ["negative tokens", { prompt_tokens: -5, completion_tokens: 10 }],
    ["missing completion_tokens", { prompt_tokens: 5 }],
    ["string tokens", { prompt_tokens: "5", completion_tokens: "10" }],
    ["infinite tokens", { prompt_tokens: 5, completion_tokens: Infinity }],
    ["zero completion_tokens on a successful reply", { prompt_tokens: 5, completion_tokens: 0 }],
    ["zero of both", { prompt_tokens: 0, completion_tokens: 0 }],
  ])("unusable usage (%s) counts the worst case", async (_, usage) => {
    const s = setup({ fetch: async () => json(reply(usage)) });
    const r = await s.ai.chat(req());
    expect(await s.spent()).toBe(bytes(MSGS) + 800);
    expect(r.usage).toBeNull();
  });

  test("zero prompt_tokens with real completion_tokens is usable", async () => {
    const s = setup({ fetch: async () => json(reply({ prompt_tokens: 0, completion_tokens: 5 })) });
    await s.ai.chat(req());
    expect(await s.spent()).toBe(10);
  });

  test("rounds each charge up to a whole micro-dollar", async () => {
    const s = setup({ prices: { m: { in: 0.04, out: 1.35 } }, fetch: async () => json(reply({ prompt_tokens: 1, completion_tokens: 1 })) });
    await s.ai.chat(req());
    expect(await s.spent()).toBe(2); // 1.39 -> 2
  });

  test("returns the content, finish_reason, usage and first message", async () => {
    const s = setup({ fetch: async () => json(reply({ prompt_tokens: 3, completion_tokens: 4 }, "yo")) });
    const r = await s.ai.chat(req());
    expect(r).toMatchObject({ content: "yo", finish_reason: "stop", usage: { prompt_tokens: 3, completion_tokens: 4 }, message: { content: "yo" } });
  });

  test("the result has no cost field: spend is read from the counter", async () => {
    const s = setup();
    expect("costMicro" in (await s.ai.chat(req()))).toBe(false);
  });

  test("null content is returned as null", async () => {
    const s = setup({ fetch: async () => json(reply(undefined, null)) });
    expect((await s.ai.chat(req())).content).toBeNull();
  });
});

describe("price table", () => {
  test("a model with no price is refused before any call", async () => {
    const s = setup();
    const e = await failure(s.ai.chat(req({ model: "z-ai/glm-5.3" })));
    expect(e).toBeInstanceOf(NearAIError);
    expect(e.code).toBe("no_price");
    expect(s.calls.length).toBe(0);
  });

  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("inherited name %s has no price", async name => {
    const s = setup();
    expect((await failure(s.ai.chat(req({ model: name })))).code).toBe("no_price");
    expect(s.calls.length).toBe(0);
  });

  test("agent.json prices the three attested models from docs/spikes.md and not glm-5.3", () => {
    const p = agentConfig.prices_usd_per_m as Record<string, { in: number; out: number }>;
    expect(p["deepseek-ai/DeepSeek-V4.1-Flash-1017"]).toEqual({ in: 0.3, out: 1.2 });
    expect(p["Qwen/Qwen3.8-27B"]).toEqual({ in: 0.04, out: 1.35 });
    expect(p["z-ai/glm-5.3-flash"]).toEqual({ in: 0.08, out: 0.5 });
    expect(p["z-ai/glm-5.3"]).toBeUndefined();
    expect(agentConfig.judge_model).toBe("Qwen/Qwen3.8-27B");
  });
});

describe("daily cap", () => {
  test("alerts once at 80% and refuses at 100% before calling", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) await s.ai.chat(req()); // 6000
    expect(s.alerts).toEqual([]);
    await s.ai.chat(req()); // 8000 = 80%
    expect(s.alerts).toEqual([{ day: "2026-11-02", spentUsd: 0.008, limitUsd: 0.01 }]);
    await s.ai.chat(req()); // 10000 = 100%, still alerts only once
    expect(s.alerts.length).toBe(1);
    expect(s.calls.length).toBe(5);

    const e = await failure(s.ai.chat(req()));
    expect(e).toBeInstanceOf(NearAIError);
    expect(e.code).toBe("spend_cap");
    expect(s.calls.length).toBe(5);
    expect(await s.spent()).toBe(10_000);
    expect(s.alerts.length).toBe(1);
  });

  test("a new UTC day resets the cap and the alert", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await s.ai.chat(req());
    expect((await failure(s.ai.chat(req()))).code).toBe("spend_cap");
    s.clock.now = Date.UTC(2026, 10, 3, 0, 0, 0);
    for (let i = 0; i < 4; i++) await s.ai.chat(req());
    expect(s.alerts.map(a => a.day)).toEqual(["2026-11-02", "2026-11-03"]);
  });

  test("a single call that jumps past 100% still alerts, and the next call is refused", async () => {
    const s = setup({ fetch: async () => json(reply({ prompt_tokens: 20_000, completion_tokens: 1 })) });
    await s.ai.chat(req());
    expect(s.alerts.length).toBe(1);
    expect((await failure(s.ai.chat(req()))).code).toBe("spend_cap");
    expect(s.alerts.length).toBe(1);
  });

  test("concurrent threshold crossings alert once", async () => {
    const s = setup({ dailyUsd: 0.002 }); // 2000: the first call reaches 100%
    await Promise.all(Array.from({ length: 5 }, () => s.ai.chat(req()).catch(() => {})));
    expect(s.alerts.length).toBe(1);
  });

  test.each([
    ["rejects", async () => { throw new Error("webhook down"); }],
    ["throws", () => { throw new Error("webhook down"); }],
  ])("an onAlert that %s does not break the call", async (_, onAlert) => {
    const s = setup({ onAlert });
    for (let i = 0; i < 4; i++) await s.ai.chat(req());
    expect(await s.spent()).toBe(8000);
  });

  test("a slow onAlert does not delay the call", async () => {
    const s = setup({ onAlert: () => new Promise(() => {}) });
    for (let i = 0; i < 4; i++) await s.ai.chat(req());
    expect(await s.spent()).toBe(8000);
  });

  test("the cap counts worst case for a call whose answer never arrived", async () => {
    const s = setup({ fetch: async () => { throw new Error("socket closed"); } });
    expect((await failure(s.ai.chat(req()))).code).toBe("network");
    expect(await s.spent()).toBe(bytes(MSGS) + 800);
  });

  test.each([
    ["a network error", async () => { throw new Error("socket closed"); }],
    ["an http 500", async () => json({ error: "nope" }, 500)],
    ["an http 401", async () => json({ error: "nope" }, 401)],
    ["a body that is not json", async () => new Response("<html>")],
    ["a body with no choices", async () => json({})],
  ])("a failed call (%s) stays charged at the worst case", async (_, f) => {
    const s = setup({ fetch: f });
    await failure(s.ai.chat(req()));
    expect(await s.spent()).toBe(bytes(MSGS) + 800);
  });

  test("a timed-out call stays charged at the worst case", async () => {
    const s = setup({ fetch: (_: string, init: RequestInit) => new Promise<Response>((_res, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("x")))) });
    expect((await failure(s.ai.chat(req({ timeoutMs: 10 })))).code).toBe("timeout");
    expect(await s.spent()).toBe(bytes(MSGS) + 800);
  });

  test.each([0, -1, NaN, Infinity])("a daily limit of %p is refused at construction", n => {
    expect(() => setup({ dailyUsd: n })).toThrow();
  });

  test("an empty api key is refused at construction", () => {
    expect(() => setup({ apiKey: "" })).toThrow();
  });
});

describe("dailyLimitUsd (NEARAI_DAILY_USD)", () => {
  test("defaults to 5", () => expect(dailyLimitUsd({})).toBe(5));
  test("reads a positive number", () => expect(dailyLimitUsd({ NEARAI_DAILY_USD: "2.5" })).toBe(2.5));
  test.each(["", "0", "-1", "abc", "NaN", "Infinity"])("rejects %p so a typo cannot switch the cap off", raw => {
    expect(() => dailyLimitUsd({ NEARAI_DAILY_USD: raw })).toThrow("NEARAI_DAILY_USD");
  });
});

describe("request", () => {
  test("posts the model, max_tokens, temperature and response_format with a bearer key", async () => {
    const s = setup();
    await s.ai.chat(req({ temperature: 0, response_format: { type: "json_object" }, tools: [{ type: "function" }], tool_choice: "auto" }));
    const [{ url, init }] = s.calls;
    expect(url).toBe("https://nearai.test/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      model: "m", messages: MSGS, max_tokens: 400, temperature: 0, response_format: { type: "json_object" }, tools: [{ type: "function" }], tool_choice: "auto",
    });
  });

  test("sends reasoning_effort when given and omits it otherwise", async () => {
    const s = setup();
    await s.ai.chat(req({ reasoning_effort: "none" }));
    await s.ai.chat(req());
    expect(JSON.parse(s.calls[0]!.init.body as string).reasoning_effort).toBe("none");
    expect("reasoning_effort" in JSON.parse(s.calls[1]!.init.body as string)).toBe(false);
  });

  test.each([undefined, 0, -1, 1.5, NaN, "400"])("max_tokens %p is refused before any call", async mt => {
    const s = setup();
    expect((await failure(s.ai.chat(req({ max_tokens: mt as never })))).code).toBe("bad_request");
    expect(s.calls.length).toBe(0);
  });

  test.each([undefined, 0, -1, NaN])("timeoutMs %p is refused before any call", async t => {
    const s = setup();
    expect((await failure(s.ai.chat(req({ timeoutMs: t as never })))).code).toBe("bad_request");
    expect(s.calls.length).toBe(0);
  });
});

describe("failure handling", () => {
  let timers: ReturnType<typeof trackTimers> | undefined;
  afterEach(() => timers?.restore());

  test("a call past the timeout is aborted", async () => {
    let signal: AbortSignal | undefined;
    const hang = (_: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => rej(new Error("aborted")));
    });
    const s = setup({ fetch: hang });
    const e = await failure(s.ai.chat(req({ timeoutMs: 20 })));
    expect(e.code).toBe("timeout");
    expect(signal?.aborted).toBe(true);
  });

  test("the caller's signal aborts the call", async () => {
    // like real fetch, reject at once when the signal is already aborted
    const hang = (_: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      const sig = init.signal as AbortSignal;
      if (sig.aborted) rej(new Error("aborted"));
      sig.addEventListener("abort", () => rej(new Error("aborted")));
    });
    const s = setup({ fetch: hang });
    const ac = new AbortController();
    const p = failure(s.ai.chat(req({ signal: ac.signal })));
    ac.abort();
    expect((await p).code).toBe("aborted");
  });

  test("a timeout that is never reached is cleared on success and on failure", async () => {
    timers = trackTimers(54_321);
    const ok = setup();
    await ok.ai.chat(req({ timeoutMs: 54_321 }));
    const bad = setup({ fetch: async () => json({}, 500) });
    await failure(bad.ai.chat(req({ timeoutMs: 54_321 })));
    expect(timers.live.size).toBe(0);
  });

  test("no retries: an http error calls fetch once", async () => {
    let n = 0;
    const s = setup({ fetch: async () => (n++, json({ error: "busy" }, 503)) });
    const e = await failure(s.ai.chat(req()));
    expect(n).toBe(1);
    expect(e.code).toBe("http");
    expect(e.status).toBe(503);
  });

  test("a network error calls fetch once", async () => {
    let n = 0;
    const s = setup({ fetch: async () => { n++; throw new Error("reset"); } });
    await failure(s.ai.chat(req()));
    expect(n).toBe(1);
  });

  test.each([
    ["not json", "<html>"],
    ["no choices", "{}"],
    ["empty choices", '{"choices":[]}'],
  ])("a 200 with a bad body (%s) is bad_response", async (_, body) => {
    const s = setup({ fetch: async () => new Response(body) });
    expect((await failure(s.ai.chat(req()))).code).toBe("bad_response");
  });

  test("errors never contain the api key", async () => {
    const leaks = [
      async () => { throw new Error(`connect failed for Bearer ${KEY}`); },
      async () => new Response(`bad key ${KEY}`, { status: 401 }),
      async () => new Response(`{"echo":"${KEY}"`, { status: 200 }), // truncated json that mentions the key
      async () => { throw Object.assign(new Error("x"), { headers: { authorization: `Bearer ${KEY}` } }); },
    ];
    for (const f of leaks) {
      const s = setup({ fetch: f });
      const e = await failure(s.ai.chat(req()));
      const everything = [e.message, String(e), e.stack ?? "", JSON.stringify(e), JSON.stringify(Object.getOwnPropertyNames(e).map(k => (e as never)[k]))].join("\n");
      expect(everything).not.toContain(KEY);
      expect(e.cause).toBeUndefined();
    }
  });

  test("the spend-cap error does not contain the key either", async () => {
    const s = setup({ dailyUsd: 0.000001 }); // not even one worst case fits
    const e = await failure(s.ai.chat(req()));
    expect(e.code).toBe("spend_cap");
    expect(`${e.message}${e.stack}`).not.toContain(KEY);
  });
});

describe("price table validation", () => {
  test.each([
    ["a missing out", { in: 1 }],
    ["a missing in", { out: 1 }],
    ["a negative in", { in: -1, out: 2 }],
    ["a negative out", { in: 1, out: -2 }],
    ["a NaN price", { in: NaN, out: 2 }],
    ["an infinite price", { in: 1, out: Infinity }],
    ["a string price", { in: "1", out: 2 }],
    ["a null entry", null],
    ["an empty entry", {}],
  ])("%s is refused at construction, so spend can never go NaN or negative", (_, price) => {
    expect(() => setup({ prices: { good: { in: 1, out: 2 }, m: price } })).toThrow(/price/);
  });

  test("a free model (price 0) and fractional prices are valid", async () => {
    const s = setup({ prices: { m: { in: 0, out: 0 } } });
    await s.ai.chat(req());
    expect(await s.spent()).toBe(0);
    expect(() => setup({ prices: { m: { in: 0.04, out: 1.35 } } })).not.toThrow();
  });

  test("the shipped agent.json table is valid", () => {
    expect(() => setup({ prices: agentConfig.prices_usd_per_m })).not.toThrow();
  });
});

describe("a broken counter cannot switch the cap off", () => {
  test.each([
    ["NaN", NaN],
    ["undefined", undefined],
    ["a string", "0"],
    ["a total over the cap that the counter did not refuse", 1e9],
  ])("a counter that answers %s refuses the call before fetch", async (_, answer) => {
    const calls: unknown[] = [];
    const counter = { get: async () => answer as number, add: async () => answer as number };
    const s = setup({ counter, fetch: async () => (calls.push(1), json(reply())) });
    expect((await failure(s.ai.chat(req()))).code).toBe("spend_cap");
    expect(calls.length).toBe(0);
  });

  test("a counter that throws fails the call without a fetch", async () => {
    const calls: unknown[] = [];
    const counter = { get: async () => 0, add: async () => { throw new Error("convex down"); } };
    const s = setup({ counter, fetch: async () => (calls.push(1), json(reply())) });
    await expect(s.ai.chat(req())).rejects.toThrow("convex down");
    expect(calls.length).toBe(0);
  });
});

describe("reservation", () => {
  const worst = bytes(MSGS) + 800;

  test("50 concurrent calls against a cap that fits one worst case make exactly one call", async () => {
    const s = setup({ dailyUsd: (worst + 100) / 1e6 });
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => s.ai.chat(req())));
    expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
    expect(s.calls.length).toBe(1);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed.length).toBe(49);
    for (const f of failed) expect((f.reason as NearAIError).code).toBe("spend_cap");
  });

  test("calls that fit together all run, and no more than fit", async () => {
    const s = setup({ dailyUsd: (3 * worst + 100) / 1e6, fetch: async () => json(reply({ prompt_tokens: 10, completion_tokens: 10 })) });
    // each settles to 30, so after the first three settle there is room again; sequential batches show the settle frees budget
    const first = await Promise.allSettled(Array.from({ length: 10 }, () => s.ai.chat(req())));
    expect(first.filter(r => r.status === "fulfilled").length).toBe(3);
    expect(await s.spent()).toBe(3 * 30);
    const second = await Promise.allSettled(Array.from({ length: 10 }, () => s.ai.chat(req())));
    expect(second.filter(r => r.status === "fulfilled").length).toBe(3);
  });

  test("the worst case is held while the call is in flight and settled to actual after", async () => {
    let during = -1;
    const s = setup({ fetch: async () => ((during = await s.spent()), json(reply({ prompt_tokens: 10, completion_tokens: 20 }))) });
    await s.ai.chat(req());
    expect(during).toBe(worst);
    expect(await s.spent()).toBe(10 * 1 + 20 * 2);
  });

  test("a usage above the reservation is settled up, not capped", async () => {
    const s = setup({ fetch: async () => json(reply({ prompt_tokens: 1000, completion_tokens: 500 })) });
    await s.ai.chat(req());
    expect(await s.spent()).toBe(2000);
  });

  test("a refused call reserves nothing", async () => {
    const s = setup({ dailyUsd: 0.000001 });
    for (let i = 0; i < 5; i++) await failure(s.ai.chat(req()));
    expect(await s.spent()).toBe(0);
    expect(s.calls.length).toBe(0);
  });

  test("a call refused for lack of room still raises the once-a-day alert if it was not raised yet", async () => {
    const s = setup({ dailyUsd: (worst + 100) / 1e6, fetch: async () => json(reply({ prompt_tokens: 10, completion_tokens: 10 })) });
    await s.counter.add(`nearai:spend:${utcDay(s.clock.now)}`, worst); // spend already near the cap from another process
    await failure(s.ai.chat(req()));
    await failure(s.ai.chat(req()));
    expect(s.alerts.length).toBe(1);
  });
});
