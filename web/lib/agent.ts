// Server only. The one way the site talks to the agent (E12, M11): the proxy secret and the client IP are added here, on the
// server, so the browser never sees the secret and cannot choose its own x-real-ip. MOCK_AGENT=1 answers from web/fixtures.
import { MAX_MESSAGE, STAGES } from "../../shared/attempt";
import attempts from "../fixtures/attempts.json";
import attestation from "../fixtures/attestation.json";
import session from "../fixtures/session.json";

export type AgentEnv = { [k: string]: string | undefined; AGENT_URL?: string; PROXY_SECRET?: string; MOCK_AGENT?: string; VERCEL?: string; TRUSTED_IP_HEADER?: string };
type Opts = { env?: AgentEnv; fetch?: typeof fetch; now?: () => number };

const MAX_BODY = 16 * 1024; // the agent's own bodyLimit
const PASS = ["content-type", "retry-after", "x-firewall-degraded"]; // the only headers that go back to the browser
const TIMEOUT_MS = 30_000;

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error: { code, message, ...extra } }, { status, headers: { "cache-control": "no-store" } });

// Only a header our own edge sets can be believed: on Vercel that is x-real-ip (Vercel overwrites what the client sent); behind
// another proxy, TRUSTED_IP_HEADER names the header it overwrites. Anything else is client-written, so no IP is sent and the
// agent refuses the request (bad_client_ip). x-forwarded-for is never used: clients can prepend to it.
export function clientIp(h: Headers, env: AgentEnv = process.env): string | null {
  const name = env.TRUSTED_IP_HEADER?.trim().toLowerCase() || (env.VERCEL ? "x-real-ip" : null);
  return (name && h.get(name)?.trim()) || null;
}

export async function callAgent(path: string, o: Opts & { method?: string; body?: string; ip?: string | null } = {}): Promise<Response> {
  const env = o.env ?? process.env;
  if (env.MOCK_AGENT === "1") return mock(path, o.method ?? "GET", o.body, (o.now ?? Date.now)());
  if (!env.AGENT_URL || !env.PROXY_SECRET) return err(503, "agent_not_configured", "The arena agent is not configured on this site.");
  const headers: Record<string, string> = { "x-bulkhead-proxy-secret": env.PROXY_SECRET };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.ip) headers["x-real-ip"] = o.ip;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(env.AGENT_URL.replace(/\/$/, "") + path, { method: o.method ?? "GET", headers, body: o.body, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return err(503, "agent_unreachable", "The arena agent cannot be reached right now. Your attempt was not counted.");
  }
  const out = new Headers({ "cache-control": "no-store" });
  for (const k of PASS) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(await res.text(), { status: res.status, headers: out });
}

// A route handler's whole body: forward the browser's request, nothing of it but the body and the client address.
export async function proxy(req: Request, path: string, o: Opts = {}): Promise<Response> {
  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // A declared length over the cap is refused before anything is read. The size check below catches a missing or false one.
    if (Number(req.headers.get("content-length")) > MAX_BODY) return err(413, "body_too_large", "The body is over 16 KiB.");
    body = await req.text();
    if (new TextEncoder().encode(body).length > MAX_BODY) return err(413, "body_too_large", "The body is over 16 KiB.");
  }
  return callAgent(path, { ...o, method: req.method, body, ip: clientIp(req.headers, o.env ?? process.env) });
}

// ---- MOCK_AGENT=1 ----------------------------------------------------------------------------------------------------------
type Fixture = { status?: number; body?: unknown; stages?: string[]; result?: Record<string, unknown>; never?: boolean };
const FIX = attempts as Record<string, Fixture>;
const STEP_MS = 400;

function mock(path: string, method: string, body: string | undefined, now: number): Response {
  if (path === "/attestation") return Response.json(attestation);
  if (path === "/session" && method === "POST") return Response.json({ session: session.session, expires_at: session.expires_at });
  if (path === "/attempt" && method === "POST") {
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(body ?? "");
    } catch {
      return err(400, "bad_request", "The body is not the expected JSON.");
    }
    const message = String(b.message ?? "");
    if (message.length > MAX_MESSAGE) return err(400, "message_too_long", `The message is over ${MAX_MESSAGE} characters.`);
    // the fixture is picked by the message: "mock:<name>", anything else is a refusal
    const name = /^mock:([a-z_]+)/.exec(message)?.[1] ?? "refused";
    const f = FIX[name] ?? FIX.refused!;
    if (f.status) return Response.json(f.body, { status: f.status, headers: f.status === 429 ? { "retry-after": String((f.body as any).error.retry_after_s) } : {} });
    return Response.json({ attempt_id: `MOCK-${name}-${now}` }, { status: 202 });
  }
  const m = /^\/attempt\/MOCK-([a-z_]+)-(\d+)$/.exec(path);
  if (m && method === "GET") {
    const f = FIX[m[1]!];
    if (!f) return err(404, "attempt_not_found", "No such attempt.");
    const stages = f.stages ?? ["reading", "thinking"];
    const i = Math.floor((now - Number(m[2])) / STEP_MS);
    if (f.never || i < stages.length) return Response.json({ stage: stages[Math.min(i, stages.length - 1)] ?? STAGES[0] });
    return Response.json({ stage: "done", result: { id: `MOCK-${m[1]}`, ...f.result } });
  }
  return err(404, "not_found", "No such route.");
}
