// The LLM judge: one NEAR AI call that rates a conversation 0-100 and names the technique.
import { readFileSync } from "node:fs";
import cfg from "../../config/agent.json";
import type { NearAI } from "../nearai";
import { judgeOut, type Judge, type JudgeOut } from "./verdict";

export const JUDGE_MODEL = cfg.judge_model;
const MAX_TOKENS = 400;
const SLOT = "{FEW_SHOT}";

// Few-shot lines are {"message","risk","technique","reason"}; message is shown as a one-message conversation.
// A bad line fails at boot, and an empty file is valid.
export function renderFewShot(jsonl: string): string {
  const shots = jsonl.split("\n").flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      const x = JSON.parse(line);
      if (typeof x?.message !== "string") throw new Error("message must be a string");
      const input = JSON.stringify({ messages: [{ role: "user", content: x.message }] });
      return [`Input: ${input}\nOutput: ${JSON.stringify(judgeOut(x))}`];
    } catch (e) {
      throw new Error(`fewshot line ${i + 1}: ${(e as Error).message}`);
    }
  });
  return shots.length ? `Examples:\n${shots.join("\n")}` : "";
}

// Both files are found relative to this module, not the current directory.
const read = (u: URL) => readFileSync(u, "utf8");
export function loadJudgePrompt(readFile: (u: URL) => string = read): string {
  const prompt = readFile(new URL("../../prompts/judge.txt", import.meta.url));
  if (!prompt.includes(SLOT)) throw new Error(`prompts/judge.txt has no ${SLOT} slot`);
  const shots = renderFewShot(readFile(new URL("../../../data/fewshot-fw-v1.jsonl", import.meta.url)));
  return prompt.replace(SLOT, () => shots); // a function, so "$&" in an example is not a replacement pattern
}

// The reply must be one JSON object. The only wrapper allowed is a single ``` or ```json fence around the whole reply.
// Never pick an object out of surrounding text: attacker text can end up in the model's output (quoted in the reason, or
// planted in a <think> block), and an echoed {"risk":0} must not outrank the real answer. Anything else throws.
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;
export function parseJudgeReply(content: string | null): JudgeOut {
  const text = content?.trim();
  if (!text) throw new Error("judge returned no content");
  return judgeOut(JSON.parse(FENCE.exec(text)?.[1] ?? text));
}

export function makeJudge(o: { client: NearAI; system?: string; model?: string; timeoutMs?: number }): Judge {
  const system = o.system ?? loadJudgePrompt();
  return async ({ messages, proposed_action, normalized }, signal) => {
    const r = await o.client.chat({
      model: o.model ?? JUDGE_MODEL,
      temperature: 0,
      max_tokens: MAX_TOKENS,
      timeoutMs: o.timeoutMs ?? 3500,
      response_format: { type: "json_object" },
      signal,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ messages, proposed_action, decoded: normalized.decoded }) },
      ],
    });
    return parseJudgeReply(r.content);
  };
}
