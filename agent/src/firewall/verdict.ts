import { createHash } from "node:crypto";
import type { normalize } from "../normalize";

export const TECHNIQUES = ["override", "roleplay", "encoding", "tool_spoof", "authority", "social", "other", "none"] as const;
export type Technique = (typeof TECHNIQUES)[number];
export type JudgeOut = { risk: number; technique: Technique; reason: string };
export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string };
export type Action = { tool: string; args: Record<string, unknown> };
// The signal aborts when the caller gives up (timeout), so a judge should pass it to whatever it calls.
export type Judge = (
  input: { messages: Msg[]; proposed_action?: Action; normalized: ReturnType<typeof normalize> },
  signal: AbortSignal,
) => Promise<JudgeOut>;
export const DEGRADED_REASON = "judge_unavailable";
export type Sign = (hash: Uint8Array) => Uint8Array | Promise<Uint8Array>;

// Phrased so a NaN risk lands on "block".
export const toVerdict = (risk: number) => (risk < 40 ? "allow" : risk < 70 ? "escalate" : "block") as "allow" | "escalate" | "block";

// The judge's reply is untrusted model output: anything outside the contract throws, and the caller fails closed.
export function judgeOut(x: unknown): JudgeOut {
  const o = (x ?? {}) as Record<string, unknown>;
  const { risk, technique, reason } = o;
  if (typeof risk !== "number" || !Number.isInteger(risk) || risk < 0 || risk > 100) throw new Error("judge risk must be an integer 0-100");
  if (!TECHNIQUES.includes(technique as Technique)) throw new Error("judge technique is not in the enum");
  if (typeof reason !== "string") throw new Error("judge reason must be a string");
  // What a degraded block says. A judged verdict must not be able to read like one.
  if (reason.trim().toLowerCase() === DEGRADED_REASON) throw new Error("judge reason is the reserved degraded-block text");
  return { risk, technique: technique as Technique, reason: [...reason].slice(0, 280).join("") };
}

// Keys sorted by UTF-16 code unit at every depth, no whitespace, strings as JSON.stringify writes them.
export function canonicalJson(v: unknown): string {
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("canonicalJson: number is not finite");
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// The input a verdict is about: sha256 hex of the canonical JSON of the validated request ({messages, proposed_action}, unknown
// fields already dropped, proposed_action left out when absent). A caller recomputes it from what it sent.
export const inputHash = (req: { messages: Msg[]; proposed_action?: Action }) =>
  createHash("sha256").update(canonicalJson({ messages: req.messages, proposed_action: req.proposed_action })).digest("hex");

// ed25519 over sha256(canonical_json(response without signature)), base64. `signer` is part of the signed bytes.
export async function signResponse<T extends Record<string, unknown>>(body: T, signer: string, sign: Sign) {
  const { signature: _drop, signer: _ignored, ...rest } = body;
  const signed = { ...rest, signer };
  const sig = await sign(createHash("sha256").update(canonicalJson(signed)).digest());
  if (sig.length !== 64) throw new Error("signature must be 64 bytes");
  return { ...signed, signature: Buffer.from(sig).toString("base64") } as Omit<T, "signature" | "signer"> & { signer: string; signature: string };
}
