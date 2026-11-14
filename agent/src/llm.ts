// The tier agent's model call: one NEAR AI chat completion with the tier's prompt and the single release_funds tool.
// Everything that comes back is attacker-influenced: this only parses it. The pipeline decides what it means.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import cfg from "../config/agent.json";
import type { NearAI } from "./nearai";

export type Tier = 1 | 2 | 3;
export type ToolCall = { name: string; args: unknown }; // args is null when the arguments were not a JSON object
export type ChatOut = { raw: unknown; toolCalls: ToolCall[]; text: string };

// One model for all three tiers: the defences differ, the model does not.
export const TIER_MODEL: Record<Tier, string> = { 1: cfg.tier_model, 2: cfg.tier_model, 3: cfg.tier_model };
export const MAX_TOKENS = 600;
export const LLM_TIMEOUT_MS = 20_000;

export const RELEASE_TOOL = {
  type: "function",
  function: {
    name: "release_funds",
    description: "Release the hoard to a recipient address.",
    parameters: {
      type: "object",
      properties: { recipient: { type: "string", description: "The address that receives the funds." } },
      required: ["recipient"],
      additionalProperties: false,
    },
  },
} as const;

// Found relative to this module, not the working directory. The hash is of the bytes on disk and the model is sent those bytes.
const read = (u: URL): Uint8Array => readFileSync(u);
export function loadTierPrompts(readFile: (u: URL) => Uint8Array = read) {
  const system = {} as Record<Tier, string>;
  const sha = {} as Record<Tier, string>;
  for (const t of [1, 2, 3] as const) {
    const bytes = readFile(new URL(`../prompts/tier-${t}.txt`, import.meta.url));
    system[t] = Buffer.from(bytes).toString("utf8");
    sha[t] = createHash("sha256").update(bytes).digest("hex");
  }
  return { system, sha };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// Every entry of tool_calls becomes a call, however broken, so a malformed attempt is seen and logged rather than dropped.
// A name that is not a string is "", and arguments that are not a JSON object (or a string holding one) are null.
export function parseToolCalls(message: Record<string, unknown>): ToolCall[] {
  const calls = message.tool_calls;
  if (calls === undefined || calls === null) return [];
  if (!Array.isArray(calls)) return [{ name: "", args: null }];
  return calls.map((c): ToolCall => {
    const fn = isObj(c) ? c.function : undefined;
    const name = isObj(fn) && typeof fn.name === "string" ? fn.name : "";
    const a = isObj(fn) ? fn.arguments : undefined;
    let args: unknown = null;
    if (typeof a === "string") {
      try {
        args = JSON.parse(a);
      } catch {}
    } else if (isObj(a)) args = a;
    return { name, args };
  });
}

export function makeChat(o: { client: NearAI; prompts?: ReturnType<typeof loadTierPrompts>["system"]; timeoutMs?: number }) {
  const system = o.prompts ?? loadTierPrompts().system;
  return async function chat(tier: Tier, userMsg: string): Promise<ChatOut> {
    if (tier !== 1 && tier !== 2 && tier !== 3) throw new RangeError(`unknown tier ${String(tier)}`);
    const r = await o.client.chat({
      model: TIER_MODEL[tier],
      temperature: 0,
      max_tokens: MAX_TOKENS,
      reasoning_effort: "none", // thinking off keeps the call well inside the timeout; tool-call reliability is measured by scripts/tier-smoke.ts
      timeoutMs: o.timeoutMs ?? LLM_TIMEOUT_MS,
      messages: [
        { role: "system", content: system[tier] },
        { role: "user", content: userMsg },
      ],
      tools: [RELEASE_TOOL],
    });
    return { raw: r.message, toolCalls: parseToolCalls(r.message), text: r.content ?? "" };
  };
}
