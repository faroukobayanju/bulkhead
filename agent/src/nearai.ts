// The one client for every NEAR AI call. A call needs max_tokens and a timeout, a model with a price, and room under the
// daily spend cap. Spend is counted in whole micro-dollars: a price in USD per million tokens is micro-USD per token.
import type { Counter } from "./counter";
import { utcDay } from "./counter";

export type Price = { in: number; out: number };
export type SpendAlert = { day: string; spentUsd: number; limitUsd: number };
export type ChatRequest = {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  timeoutMs: number;
  temperature?: number;
  response_format?: { type: string };
  tools?: unknown[];
  tool_choice?: unknown;
  signal?: AbortSignal;
};
export type ChatResult = {
  content: string | null; // null when the model returned no text, e.g. reasoning used up max_tokens
  finish_reason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  message: Record<string, unknown>; // first choice's message, for tool_calls
  costMicro: number;
};
export type NearAI = { chat(r: ChatRequest): Promise<ChatResult> };

export type NearAIErrorCode = "bad_request" | "no_price" | "spend_cap" | "timeout" | "aborted" | "network" | "http" | "bad_response";
// Messages are fixed strings plus a status or model name: no response body, no header, no key.
export class NearAIError extends Error {
  constructor(public code: NearAIErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "NearAIError";
  }
}

export const spendKey = (ms: number) => `nearai:spend:${utcDay(ms)}`;

export function dailyLimitUsd(env: Record<string, string | undefined>): number {
  const raw = env.NEARAI_DAILY_USD;
  if (raw === undefined) return 5;
  const n = Number(raw);
  // a NaN or 0 limit would compare false everywhere and switch the cap off
  if (!(n > 0 && Number.isFinite(n))) throw new Error(`NEARAI_DAILY_USD must be a positive number, got "${raw}"`);
  return n;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

// ponytail: the cap is checked before a call and charged after it, so calls in flight together can overshoot it by their own cost
export function makeNearAI(o: {
  fetch: typeof fetch;
  apiKey: string;
  base: string;
  prices: Record<string, Price>;
  counter: Counter;
  clock: () => number;
  dailyUsd: number;
  onAlert: (a: SpendAlert) => void | Promise<void>;
}): NearAI {
  if (!o.apiKey) throw new Error("NEARAI_API_KEY is required");
  if (!(o.dailyUsd > 0 && Number.isFinite(o.dailyUsd))) throw new Error(`daily spend limit must be a positive number, got ${o.dailyUsd}`);
  const limit = Math.round(o.dailyUsd * 1e6);
  const safe = (s: string) => s.split(o.apiKey).join("[redacted]");

  async function alertOnce(day: string, spent: number) {
    if (spent < limit * 0.8 || (await o.counter.add(`nearai:alert:${day}`, 1, 1)) === null) return;
    // not awaited and never throws: a slow or broken webhook must not delay or fail the call
    try {
      Promise.resolve(o.onAlert({ day, spentUsd: spent / 1e6, limitUsd: o.dailyUsd })).catch(() => {});
    } catch {}
  }

  return {
    async chat(r) {
      if (!Number.isInteger(r.max_tokens) || r.max_tokens <= 0) throw new NearAIError("bad_request", "max_tokens is required");
      if (!(r.timeoutMs > 0)) throw new NearAIError("bad_request", "timeoutMs is required");
      const price = Object.hasOwn(o.prices, r.model) ? o.prices[r.model] : undefined;
      if (!price) throw new NearAIError("no_price", `no price for model ${r.model}`);

      const at = o.clock();
      const day = utcDay(at);
      const key = spendKey(at);
      const before = await o.counter.get(key);
      if (before >= limit) {
        await alertOnce(day, before);
        throw new NearAIError("spend_cap", "daily NEAR AI spend limit reached");
      }
      const cost = (prompt: number, completion: number) => Math.ceil(prompt * price.in + completion * price.out);
      // No usage to read: a token is at most one byte of the request, and the reply is at most max_tokens.
      const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
      const worst = cost(bytes(r.messages) + (r.tools ? bytes(r.tools) : 0), r.max_tokens);
      const charge = async (micro: number) => {
        await alertOnce(day, (await o.counter.add(key, micro))!);
        return micro;
      };

      const ac = new AbortController();
      const signal = r.signal ? AbortSignal.any([ac.signal, r.signal]) : ac.signal;
      let timedOut = false;
      const timer = setTimeout(() => ((timedOut = true), ac.abort()), r.timeoutMs);
      let res: Response, text: string;
      try {
        const { model, messages, max_tokens, temperature, response_format, tools, tool_choice } = r;
        res = await o.fetch(`${o.base}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages, max_tokens, temperature, response_format, tools, tool_choice }),
          signal,
        });
        text = await res.text();
      } catch (e) {
        await charge(worst); // the model may have run and billed
        const code = timedOut ? "timeout" : signal.aborted ? "aborted" : "network";
        throw new NearAIError(code, code === "network" ? safe(`NEAR AI request failed: ${(e as Error)?.message ?? e}`) : `NEAR AI call ${code}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new NearAIError("http", `NEAR AI returned ${res.status}`, res.status);

      let body: any;
      try {
        body = JSON.parse(text);
      } catch {}
      const u = body?.usage;
      const usage = isCount(u?.prompt_tokens) && isCount(u?.completion_tokens) ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens } : null;
      const costMicro = await charge(usage ? cost(usage.prompt_tokens, usage.completion_tokens) : worst);
      const choice = body?.choices?.[0];
      if (!choice || typeof choice.message !== "object" || choice.message === null) throw new NearAIError("bad_response", "NEAR AI response has no message");
      return {
        content: typeof choice.message.content === "string" ? choice.message.content : null,
        finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
        usage,
        message: choice.message,
        costMicro,
      };
    },
  };
}
