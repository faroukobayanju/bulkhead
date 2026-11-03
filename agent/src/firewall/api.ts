import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { normalize } from "../normalize";
import type { Budget } from "./budget";
import { heuristicScore } from "./heuristics";
import { DEGRADED_REASON, inputHash, judgeOut, signResponse, toVerdict, type Action, type Judge, type Msg, type Sign, type Technique } from "./verdict";
import { ipKey, SlidingWindow } from "./window";

export type { Judge };
// Defaults for tests and local use only. Production passes the real values from config (codehash, firewallVersion), never env.
export const FIREWALL_VERSION = "fw-v1";
export const CODEHASH = "local";

export type CheckReq = { messages: Msg[]; proposed_action?: Action };
export type FirewallResult = {
  verdict: "allow" | "escalate" | "block";
  risk: number;
  technique: Technique;
  reason: string;
  firewall_version: string;
  codehash: string;
  latency_ms: number;
  degraded: boolean;
};

// Final risk is max(heuristic, judge): a judge that was itself talked into saying 0 cannot lower the heuristic score.
// Anything that goes wrong (judge error, timeout, output outside the contract, even a bug here) is the fail-closed block.
export async function checkFirewall(req: CheckReq, judge: Judge, opts: { timeoutMs?: number; codehash?: string; firewallVersion?: string } = {}): Promise<FirewallResult> {
  const t0 = performance.now();
  const done = (r: Pick<FirewallResult, "verdict" | "risk" | "technique" | "reason" | "degraded">): FirewallResult => ({
    ...r,
    firewall_version: opts.firewallVersion ?? FIREWALL_VERSION,
    codehash: opts.codehash ?? CODEHASH,
    latency_ms: Math.round(performance.now() - t0),
  });
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // proposed_action args are attacker-controlled text too (a memo field, a base64 blob), so they are scanned and decoded like a
    // message. The tool name is not: it is the agent's own, and the judge reads it.
    const raw = [...req.messages.map(m => m.content), ...(req.proposed_action ? [argsText(req.proposed_action.args)] : [])].join("\n");
    const n = normalize(raw);
    const h = heuristicScore(n, raw);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => (ac.abort(), reject(new Error("timeout"))), opts.timeoutMs ?? 3500);
    });
    const j = judgeOut(await Promise.race([judge({ messages: req.messages, proposed_action: req.proposed_action, normalized: n }, ac.signal), timeout]));
    const risk = Math.max(h.score, j.risk);
    const floor = h.score > j.risk; // the heuristic set the risk, so it also names the technique and the reason
    return done({
      verdict: toVerdict(risk),
      risk,
      technique: floor ? h.technique : j.technique,
      reason: floor ? `heuristic: ${h.hits.join(", ")}` : j.reason,
      degraded: false,
    });
  } catch {
    return done({ verdict: "block", risk: 100, technique: "other", reason: DEGRADED_REASON, degraded: true });
  } finally {
    clearTimeout(timer);
  }
}

const MAX_BODY = 16_384;
const ROLES = ["system", "user", "assistant", "tool"];
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const sha = (s: string) => createHash("sha256").update(s).digest();
// Hashing both sides gives equal-length inputs, so the comparison time says nothing about the secret. An unset secret matches nothing.
const sameSecret = (given: string | undefined, secret: string | undefined) => !!secret && !!given && timingSafeEqual(sha(given), sha(secret));

// The body in bytes, read from the stream and abandoned as soon as it passes `max`. Content-Length is never consulted.
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

// JSON text of the args with its string escapes undone. JSON.stringify writes a newline as the two characters \n, which glue to
// the next word ("nall") and break every \b rule, and it escapes the quotes of a spoofed {"name":"release_funds"}. After this
// the text reads like a message. It is no longer valid JSON; it is only scanned.
const argsText = (args: Record<string, unknown>) => JSON.stringify(args).replace(/\\(?:u[0-9a-fA-F]{4}|[^u])/g, m => JSON.parse(`"${m}"`));

// Returns the cleaned request, or what is wrong with it. Messages and the action are rebuilt from known fields only.
function parseReq(x: unknown): CheckReq | string {
  if (!isObj(x)) return "the body must be a JSON object";
  const { messages, proposed_action } = x;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 50) return "messages must be an array of 1 to 50 items";
  const clean: Msg[] = [];
  for (const m of messages) {
    if (!isObj(m) || !ROLES.includes(m.role as string) || typeof m.content !== "string") return "each message needs a role (system, user, assistant or tool) and a string content";
    clean.push({ role: m.role as Msg["role"], content: m.content });
  }
  if (proposed_action === undefined) return { messages: clean };
  if (!isObj(proposed_action) || typeof proposed_action.tool !== "string" || !isObj(proposed_action.args)) return "proposed_action must be {tool: string, args: object}";
  return { messages: clean, proposed_action: { tool: proposed_action.tool, args: proposed_action.args } };
}

export type FirewallDeps = {
  judge: Judge;
  keys: (apiKey: string) => Promise<boolean>; // sha256 lookup in api_keys
  limiter: SlidingWindow;
  budget: Budget;
  proxySecret?: string; // the web proxy's x-bulkhead-proxy-secret; unset closes the playground
  sign: Sign;
  signer: string;
  codehash?: string; // from config, reported in every verdict
  firewallVersion?: string;
  lookupLimiter?: SlidingWindow; // unknown-key lookups per client address, before Convex (default 30 a minute)
  clock?: () => number;
  timeoutMs?: number;
};

const KEY_NEG_TTL_MS = 60_000;
const KEY_POS_TTL_MS = 30_000;
const KEY_CACHE_MAX = 10_000;
const LOOKUPS_PER_MIN = 30;

// Nothing is logged here: Task 9's error handler decides what to record.
export function firewallRoutes(app: Hono, deps: FirewallDeps) {
  // Keys are looked up in Convex. Answers are cached briefly (a flood of one unknown key costs one lookup a minute) and the lookups
  // that do reach Convex are limited per client address, so a stream of random keys cannot turn into a stream of database calls.
  // ponytail: a revoked key still works for up to 30 s; the peer address behind a proxy is the proxy, so the limit is then shared.
  const keyCache = new Map<string, { ok: boolean; until: number }>();
  const lookupLimiter = deps.lookupLimiter ?? new SlidingWindow();
  const lookup = async (apiKey: string, ip: string, now: number): Promise<boolean | "limited"> => {
    const h = sha(apiKey).toString("hex");
    const hit = keyCache.get(h);
    if (hit && hit.until > now) return hit.ok;
    if (lookupLimiter.hit(`kl:${ip}`, LOOKUPS_PER_MIN, now)) return "limited";
    const ok = await deps.keys(apiKey);
    if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value!);
    keyCache.set(h, { ok, until: now + (ok ? KEY_POS_TTL_MS : KEY_NEG_TTL_MS) });
    return ok;
  };
  const fail = (c: Context, status: ContentfulStatusCode, code: string, message: string, fix: string, headers?: Record<string, string>) =>
    c.json({ error: { code, message, fix } }, status, headers);

  app.post("/v1/check", async c => {
    const now = (deps.clock ?? Date.now)();

    // 1. who is calling
    const apiKey = c.req.header("x-api-key");
    let id: string;
    let keyId: string | undefined;
    let perMinute: number;
    if (apiKey) {
      let known: boolean | "limited" = false;
      // the address is believed only from the proxy; a direct caller is keyed by the connection's peer
      const peer = (c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined)?.requestIP?.(c.req.raw)?.address;
      const from = sameSecret(c.req.header("x-bulkhead-proxy-secret"), deps.proxySecret) && isIP(c.req.header("x-real-ip") ?? "") ? ipKey(c.req.header("x-real-ip")!) : peer ?? "unknown";
      try {
        known = apiKey.length <= 256 && (await lookup(apiKey, from, now));
      } catch {
        return fail(c, 503, "key_lookup_unavailable", "API keys cannot be checked right now.", "Retry in a moment.");
      }
      if (known === "limited") return fail(c, 429, "rate_limited", "Too many unknown API keys from this address.", "Wait a minute, then retry with a valid key.", { "retry-after": "60" });
      if (!known) return fail(c, 401, "invalid_api_key", "Unknown API key.", "Send a valid key in the x-api-key header.");
      keyId = sha(apiKey).toString("hex").slice(0, 32);
      [id, perMinute] = [`k:${keyId}`, 60];
    } else {
      if (!sameSecret(c.req.header("x-bulkhead-proxy-secret"), deps.proxySecret))
        return fail(c, 401, "missing_api_key", "No API key.", "Send your key in the x-api-key header.");
      const ip = c.req.header("x-real-ip");
      if (!ip || !isIP(ip)) return fail(c, 400, "bad_client_ip", "The proxy did not send a valid x-real-ip.", "The web proxy must set x-real-ip to the client address.");
      [id, perMinute] = [`ip:${ipKey(ip)}`, 5];
    }

    // 2. per-minute limit
    const wait = deps.limiter.hit(id, perMinute, now);
    if (wait) return fail(c, 429, "rate_limited", `More than ${perMinute} calls in a minute.`, `Wait ${wait} seconds, then retry.`, { "retry-after": String(wait) });

    // 3. size, from the bytes actually read
    const bytes = await readBody(c.req.raw, MAX_BODY);
    if (!bytes) return fail(c, 413, "body_too_large", `The body is over ${MAX_BODY} bytes.`, `Send at most ${MAX_BODY} bytes.`);

    // 4. parse and validate
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return fail(c, 400, "bad_json", "The body is not valid JSON.", 'Send {"messages":[{"role":"user","content":"..."}]}.');
    }
    const req = parseReq(json);
    if (typeof req === "string") return fail(c, 400, "bad_request", req, 'Send {"messages":[{"role":"user","content":"..."}],"proposed_action":{"tool":"...","args":{}}}.');
    // The hash is computed here, before anything is charged or judged. JSON.parse reads 1e999 as Infinity, which passes the
    // shape checks but has no canonical JSON, so such a request is a bad request, not a failure after a paid judge call.
    let input_hash: string;
    try {
      input_hash = inputHash(req);
    } catch {
      return fail(c, 400, "bad_request", "A number in the request is too large for JSON (such as 1e999).", "Use numbers JSON can carry, or send the value as a string.");
    }

    // 5. daily budget: only a request the judge will actually run is counted
    let ok: boolean;
    try {
      ok = keyId ? await deps.budget.chargeApi(keyId) : await deps.budget.chargePlayground();
    } catch {
      return fail(c, 503, "budget_unavailable", "The daily budget cannot be checked right now.", "Retry in a moment.");
    }
    if (!ok) return fail(c, 503, "budget_exhausted", "The daily check budget is used up.", "It resets at 00:00 UTC. Retry then.");

    // 6. judge, then sign. A degraded block is still a 200: reason stays "judge_unavailable" and the header marks it.
    // input_hash and issued_at go inside the signed bytes, so a verdict cannot be shown next to another input or passed off as new.
    const { degraded, ...result } = await checkFirewall(req, deps.judge, { timeoutMs: deps.timeoutMs, codehash: deps.codehash, firewallVersion: deps.firewallVersion });
    const stamped = { ...result, input_hash, issued_at: Math.floor((deps.clock ?? Date.now)()) };
    try {
      return c.json(await signResponse(stamped, deps.signer, deps.sign), 200, degraded ? { "x-firewall-degraded": "1" } : undefined);
    } catch {
      return fail(c, 503, "signing_unavailable", "The verdict could not be signed.", "Retry in a moment.");
    }
  });
}
