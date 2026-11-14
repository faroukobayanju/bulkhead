// The agent's side of the database (E20): every call is POST /agent/<op> on the Convex site with x-agent-secret, through an
// injected fetch. Account and IP are hashed here with PEPPER, so Convex only ever sees hashes. There is no Postgres.
import { createHash } from "node:crypto";
import { attemptView } from "../../shared/attempt-view";
import { attemptLeaf } from "../../shared/leaf";
import type { Outcome, Stage } from "../../shared/attempt";
import type { Counter } from "./counter";
import type { FirewallResult } from "./firewall/api";
import { signResponse, type Sign } from "./firewall/verdict";

// What the pipeline hands over: raw account and ip, which never leave this file.
export type AttemptRow = {
  id: string;
  ts: string; // ISO-8601 UTC with milliseconds (the leaf covers it as written)
  tier: 1 | 2 | 3;
  account: string;
  ip: string;
  message: string;
  normalized: string;
  fw_a: FirewallResult | null;
  llm_output?: unknown; // the raw assistant message; absent when the model never ran
  tool_called: boolean;
  fw_b: FirewallResult | null;
  outcome: Outcome;
  technique: string | null;
  prompt_sha256: string;
  model_id: string;
  attestation_sha256: string;
  codehash: string;
  near_tx: string | null;
  chain_txid: string | null;
  payout_address: string;
  consent_version: string;
  reply: string;
  stage: Stage;
  response_verified?: boolean; // E17: every model response of the attempt had a signature that checked out; absent counts as false
};
export type AttemptPatch = { outcome: Outcome; reply?: string; near_tx?: string; chain_txid?: string };

export class DbError extends Error {
  // The message is a fixed shape (op, status, Convex's error code): nothing from the request or the response body.
  constructor(public op: string, public status: number, public code?: string) {
    super(`db ${op} failed: ${status}${code ? ` ${code}` : ""}`);
    this.name = "DbError";
  }
}

const FW_KEYS = ["verdict", "risk", "technique", "reason", "firewall_version", "codehash", "latency_ms", "degraded"] as const;
// Text that came from a player or a model can hold a lone surrogate, which JSON writes as \ud800 and Convex's parser refuses.
// Replaced with U+FFFD before sending, so the row is stored, and the leaf covers the text as stored.
const wf = (s: string) => s.toWellFormed();
const fw = (x: FirewallResult | null | undefined) => (x ? { ...Object.fromEntries(FW_KEYS.map(k => [k, x[k]])), reason: wf(x.reason) } : null);
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

// `signer` (E5): when set, every row is signed on insert and again on every outcome change, with the key that signs verdicts.
export function makeDb(o: { fetch: typeof fetch; siteUrl: string; secret: string; pepper: string; timeoutMs?: number; signer?: { id: string; sign: Sign } }) {
  // A short or missing pepper makes the hashes of NEAR accounts and IPv4 addresses easy to reverse: the agent does not start.
  if (typeof o.pepper !== "string" || o.pepper.length < 16) throw new Error("PEPPER is required (at least 16 characters, 32+ random bytes in production)");
  if (!o.secret) throw new Error("AGENT_SECRET is required");
  let base: URL;
  try {
    base = new URL(o.siteUrl);
  } catch {
    throw new Error("CONVEX_SITE_URL must be a URL");
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOCAL.has(base.hostname))) throw new Error("CONVEX_SITE_URL must be https (http is only for a local dev backend), or the secret would travel in the clear");
  const root = base.origin;
  const timeoutMs = o.timeoutMs ?? 10_000;
  // an undefined or empty value would hash to one shared value, putting every such player in one bucket
  const hash = (value: string) => {
    if (typeof value !== "string" || !value) throw new TypeError("account and ip must be non-empty strings");
    return createHash("sha256").update(value + o.pepper).digest("hex");
  };

  async function call(op: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await o.fetch(`${root}/agent/${op}`, {
        method: "POST",
        headers: { "x-agent-secret": o.secret, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new DbError(op, 0, (e as Error)?.name === "TimeoutError" ? "timeout" : "network");
    }
    let parsed: any;
    try {
      parsed = await res.json();
    } catch {}
    if (!res.ok) throw new DbError(op, res.status, typeof parsed?.error === "string" ? parsed.error : undefined);
    if (typeof parsed !== "object" || parsed === null) throw new DbError(op, res.status, "bad_response");
    return parsed.result ?? null;
  }

  const num = (op: string, x: unknown) => {
    if (typeof x !== "number") throw new DbError(op, 200, "bad_response");
    return x;
  };
  const bool = (x: unknown) => x === true;

  // ed25519 over sha256(canonical JSON of the public row without stage, with `signer` inside): see shared/attempt-view.ts.
  const seal = async (v: Parameters<typeof attemptView>[0]) => {
    if (!o.signer) return {};
    const { signature, signer } = await signResponse(attemptView(v), o.signer.id, o.signer.sign);
    return { signature, signer };
  };

  const counter: Counter = {
    get: async key => num("counter_get", await call("counter_get", { key })),
    async add(key, n, cap) {
      const r = await call("counter_add", cap === undefined ? { key, n } : { key, n, cap });
      return r === null ? null : num("counter_add", r);
    },
  };

  return {
    counter,
    async ping() {
      await call("health", {});
    },

    // The leaf is computed here, at insert time and from the hashed account, and is never touched again (E7).
    async insertAttempt(r: AttemptRow) {
      const account_hash = hash(r.account);
      const message = wf(r.message);
      const leaf = attemptLeaf({ id: r.id, ts: r.ts, tier: r.tier, account_hash, message, outcome: r.outcome, prompt_sha256: r.prompt_sha256, model_id: r.model_id, attestation_sha256: r.attestation_sha256, codehash: r.codehash });
      const sealed = await seal({ ...r, message, reply: wf(r.reply), response_verified: r.response_verified ?? false });
      await call("attempt_insert", {
        id: r.id,
        ts: r.ts,
        tier: r.tier,
        account_hash,
        ip_hash: hash(r.ip),
        message,
        normalized: wf(r.normalized),
        fw_a: fw(r.fw_a),
        llm_output: r.llm_output == null ? null : JSON.stringify(r.llm_output),
        tool_called: r.tool_called,
        fw_b: fw(r.fw_b),
        outcome: r.outcome,
        technique: r.technique ?? null,
        prompt_sha256: r.prompt_sha256,
        model_id: r.model_id,
        attestation_sha256: r.attestation_sha256,
        codehash: r.codehash,
        near_tx: r.near_tx ?? null,
        chain_txid: r.chain_txid ?? null,
        payout_address: r.payout_address,
        consent_version: r.consent_version,
        reply: wf(r.reply),
        stage: r.stage,
        leaf,
        response_verified: r.response_verified ?? false,
        ...sealed,
      });
    },

    async updateAttempt(id: string, p: AttemptPatch) {
      const { outcome, reply, near_tx, chain_txid } = p;
      let sealed = {};
      if (o.signer) {
        // sign the row as it will read after this update, from what is stored
        const cur = (await call("attempt_get", { id })) as Record<string, any> | null;
        if (cur) sealed = await seal({ ...cur, outcome, reply: reply !== undefined ? wf(reply) : cur.reply, near_tx: near_tx !== undefined ? near_tx : cur.near_tx, chain_txid: chain_txid !== undefined ? chain_txid : cur.chain_txid } as never);
      }
      await call("attempt_finish", { id, outcome, ...(reply !== undefined && { reply: wf(reply) }), ...(near_tx !== undefined && { near_tx }), ...(chain_txid !== undefined && { chain_txid }), ...sealed });
    },
    // E6: the release tx hash and its reference height, written before the call is sent
    async markSent(id: string, r: { tx: string; refHeight: number }) {
      await call("attempt_sent", { id, release_tx: r.tx, release_ref_height: r.refHeight });
    },
    // Rows still `releasing` or `signed_pending_broadcast`, and `drained` ones since `drainedSince`
    async listPayouts(drainedSince: string) {
      return (await call("attempts_payouts", { drained_since: drainedSince })) as { id: string; tier: 1 | 2 | 3; outcome: string; ts: string; near_tx: string | null; release_tx: string | null; release_ref_height: number | null }[];
    },
    // false: nothing changed (the row does not exist yet, or the stage is not forward of the stored one)
    async setStage(id: string, stage: Stage) {
      return bool(await call("attempt_stage", { id, stage }));
    },
    async report(r: { attempt_id: string; account: string }) {
      return (await call("attempt_report", { attempt_id: r.attempt_id, account_hash: hash(r.account) })) as { hidden: boolean };
    },

    async insertReplay(r: { attempt_id: string; fw_version: string; verdict: "allow" | "escalate" | "block"; risk: number }) {
      return bool(await call("replay_put", r));
    },
    // Tier 1 and 2 rows that called the tool and have no replay for `fwVersion`. Page with `next` until `done`.
    async replayTodo(fwVersion: string, cursor: string | null = null, limit = 100) {
      return (await call("replay_todo", { fw_version: fwVersion, cursor, limit })) as { rows: { id: string; message: string; payout_address: string }[]; next: string; done: boolean };
    },
    // `hash` is the sha256 of the key, never the key.
    async apiKeyExists(keyHash: string) {
      return bool(await call("key_exists", { key_hash: keyHash }));
    },
    async putApiKey(keyHash: string, label?: string) {
      return bool(await call("key_put", { key_hash: keyHash, ...(label !== undefined && { label }) }));
    },

    async putSignedTx(r: { attempt_id: string; chain: "btc" | "evm"; hex: string }) {
      return bool(await call("signed_tx_put", r));
    },
    async getSignedTx(attempt_id: string) {
      return (await call("signed_tx_get", { attempt_id })) as { chain: "btc" | "evm"; hex: string } | null;
    },

    // Every column, hidden rows too, in ts order from `sinceTs`. Page with `next` until `done`.
    async listAttempts(sinceTs: string, cursor: string | null = null, limit = 500) {
      return (await call("attempts_export", { since: sinceTs, cursor, limit })) as { rows: Record<string, unknown>[]; next: string; done: boolean };
    },
  };
}
export type Db = ReturnType<typeof makeDb>;
