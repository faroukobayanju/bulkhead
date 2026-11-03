// The only way to write: POST /agent/<op> with header x-agent-secret equal to the Convex env var AGENT_SECRET (E20).
// Order of checks: secret (401), op (404), size (413), JSON and shape (400), then the internal function. The secret comes first, so a caller
// without it learns nothing, not even which ops exist. There is no public mutation anywhere: this is the only door.
import { httpActionGeneric, httpRouter, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import * as attempts from "./attempts";
import * as counters from "./counters";
import * as records from "./records";

// The op table. The validators are the functions' own (read from the registered function), so this layer and the function cannot disagree.
// exportArgs is on every registered function at runtime, though the types do not show it.
type Registered = { exportArgs(): string; isMutation?: boolean };
const op = (name: string, fn: unknown) => ({ name, fn: fn as Registered, ref: makeFunctionReference<"mutation" | "query">(name), args: JSON.parse((fn as Registered).exportArgs()) as J });
export const OPS: Record<string, ReturnType<typeof op>> = {
  health: op("records:ping", records.ping),
  attempt_insert: op("attempts:insert", attempts.insert),
  attempt_finish: op("attempts:finish", attempts.finish),
  attempt_get: op("attempts:getFull", attempts.getFull),
  attempt_stage: op("attempts:setStage", attempts.setStage),
  attempt_report: op("attempts:report", attempts.report),
  attempts_export: op("attempts:exportPage", attempts.exportPage),
  replay_put: op("records:putReplay", records.putReplay),
  key_exists: op("records:keyExists", records.keyExists),
  key_put: op("records:putKey", records.putKey),
  signed_tx_put: op("records:putSignedTx", records.putSignedTx),
  signed_tx_get: op("records:getSignedTx", records.getSignedTx),
  counter_add: op("counters:add", counters.add),
  counter_get: op("counters:get", counters.get),
};

// Validators as `exportArgs()` writes them. Anything this does not understand throws: a new kind of validator must be added here on purpose.
type J = { type: string; value?: any };
const plain = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
function mismatch(t: J, x: unknown, path: string): string | null {
  const no = (what: string) => `${path}: ${what}`;
  switch (t.type) {
    case "string": return typeof x === "string" ? null : no("expected a string");
    case "number": return typeof x === "number" && Number.isFinite(x) ? null : no("expected a finite number");
    case "boolean": return typeof x === "boolean" ? null : no("expected a boolean");
    case "null": return x === null ? null : no("expected null");
    case "any": return null;
    case "literal": return x === t.value ? null : no("not an allowed value");
    case "array": return Array.isArray(x) ? x.map((e, i) => mismatch(t.value, e, `${path}[${i}]`)).find(Boolean) ?? null : no("expected an array");
    case "union": return t.value.some((m: J) => mismatch(m, x, path) === null) ? null : no("not an allowed form");
    case "object": {
      if (!plain(x)) return no("expected an object");
      const fields = t.value as Record<string, { fieldType: J; optional: boolean }>;
      for (const k of Object.keys(x)) if (!Object.hasOwn(fields, k)) return `${path}.${k}: unexpected field`;
      for (const [k, f] of Object.entries(fields)) {
        if (!Object.hasOwn(x, k)) {
          if (!f.optional) return `${path}.${k}: missing`;
          continue;
        }
        const e = mismatch(f.fieldType, x[k], `${path}.${k}`);
        if (e) return e;
      }
      return null;
    }
    default: throw new Error(`unsupported validator type ${t.type}`);
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const STATUS: Record<string, number> = { bad_request: 400, not_found: 404, conflict: 409, bad_transition: 409 };

// A typed error keeps its code and its detail (a field name or a state). Anything else says nothing about what went wrong.
export function errorResponse(e: unknown): Response {
  const d = e instanceof ConvexError ? (e.data as unknown) : null;
  if (!plain(d) || typeof d.code !== "string" || !Object.hasOwn(STATUS, d.code)) return json(500, { error: "internal" });
  return json(STATUS[d.code]!, typeof d.detail === "string" ? { error: d.code, detail: d.detail } : { error: d.code });
}

// Both sides are hashed first, so the comparison is over 32 bytes whatever the secrets' lengths, and its time does not depend on
// where they differ. An unset or empty secret matches nothing.
const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export async function sameSecret(given: string | null | undefined, secret: string | undefined): Promise<boolean> {
  if (!given || !secret) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const MAX_BODY = 512 * 1024;
const PREFIX = "/agent/";

const http = httpRouter();
http.route({
  pathPrefix: PREFIX,
  method: "POST",
  handler: httpActionGeneric(async (ctx, req) => {
    if (!(await sameSecret(req.headers.get("x-agent-secret"), process.env.AGENT_SECRET))) return json(401, { error: "unauthorized" });
    // the path as sent: not decoded, so "he%61lth" is not "health"
    const name = new URL(req.url).pathname.slice(PREFIX.length);
    if (!Object.hasOwn(OPS, name)) return json(404, { error: "unknown_op" });
    const def = OPS[name]!;

    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY) return json(413, { error: "too_large" });
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { error: "bad_request", detail: "not JSON" });
      }
    }
    const bad = mismatch(def.args, body, "$");
    if (bad) return json(400, { error: "bad_request", detail: bad });

    try {
      const out = def.fn.isMutation ? await ctx.runMutation(def.ref as never, body as never) : await ctx.runQuery(def.ref as never, body as never);
      return json(200, { result: out ?? null });
    } catch (e) {
      return errorResponse(e);
    }
  }),
});
export default http;
