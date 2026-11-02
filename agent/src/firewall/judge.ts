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

// The first {...} block, skipping braces inside JSON strings. Null when there is none or it never closes.
function firstObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export function parseJudgeReply(content: string | null): JudgeOut {
  if (!content?.trim()) throw new Error("judge returned no content");
  const block = firstObject(content);
  if (!block) throw new Error("judge reply has no JSON object");
  return judgeOut(JSON.parse(block));
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
