// convex-test over the real functions, without codegen or a deployment: the module map is written out, and the empty
// _generated entry only tells convex-test where the functions folder is.
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../../convex/schema";

export const modules = {
  "../../convex/_generated/api.js": async () => ({}),
  "../../convex/attempts.ts": () => import("../../convex/attempts"),
  "../../convex/counters.ts": () => import("../../convex/counters"),
  "../../convex/records.ts": () => import("../../convex/records"),
  "../../convex/http.ts": () => import("../../convex/http"),
};

export const SECRET = "test-agent-secret-0123456789abcdef";
export const api = anyApi;
export const H = (c: string) => c.repeat(64);

export const FW = { verdict: "allow", risk: 12, technique: "none", reason: "SECRET-REASON-a looks fine", firewall_version: "fw-v1", codehash: "local", latency_ms: 40, degraded: false } as const;

// A valid attempt as it goes over the wire. Hashes are already hashed: raw account and IP never reach Convex.
export const wireRow = (o: Record<string, unknown> = {}) => ({
  id: "01JC2ZK6V3Q8N5R7T9W1X3Y5Z7",
  ts: "2026-11-02T12:34:56.789Z",
  tier: 3,
  account_hash: H("a"),
  ip_hash: H("b"),
  message: "hello dragon",
  normalized: "hello dragon",
  fw_a: FW,
  llm_output: JSON.stringify({ role: "assistant", content: "SECRET-LLM-OUTPUT No." }),
  tool_called: false,
  fw_b: null,
  outcome: "refused",
  technique: "none",
  prompt_sha256: H("c"),
  model_id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  attestation_sha256: H("d"),
  codehash: "local",
  near_tx: null,
  chain_txid: null,
  payout_address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  consent_version: "consent-v1",
  reply: "No.",
  stage: "done",
  leaf: H("e"),
  ...o,
});

// the nth id, ordered by n
export const idN = (n: number) => "01JC2ZK6V3" + String(n).padStart(16, "0");

export function setup() {
  process.env.AGENT_SECRET = SECRET;
  const t = convexTest(schema, modules);
  const post = async (op: string, body: unknown, headers: Record<string, string> = { "x-agent-secret": SECRET }) => {
    const res = await t.fetch(`/agent/${op}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  const dump = () =>
    t.run(async ctx => ({
      attempts: await ctx.db.query("attempts").collect(),
      replays: await ctx.db.query("replays").collect(),
      api_keys: await ctx.db.query("api_keys").collect(),
      signed_txs: await ctx.db.query("signed_txs").collect(),
      reports: await ctx.db.query("reports").collect(),
      counters: await ctx.db.query("counters").collect(),
    }));
  return { t, post, dump };
}
