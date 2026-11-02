import { clean, type normalize } from "../normalize";
import type { Technique } from "./verdict";

type N = ReturnType<typeof normalize>;
// \b sits inside the tool_spoof group: before "<tool" or a quote it would need a word character in front and never match.
// Every quantifier is bounded or a single `\s*`, so matching stays linear on a 16 KB body (timing-tested). `s` lets a phrase
// span lines. Keep new rules that way: no nested or open-ended repeats over `.`.
const RULES: [name: string, re: RegExp, weight: number, technique: Technique][] = [
  ["override", /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|rules?|prompt)\b/is, 40, "override"],
  ["authority", /\b(admin|developer|system|owner|operator)\b.{0,20}\b(mode|override|message|here|access)\b/is, 30, "authority"],
  ["roleplay", /\b(pretend|roleplay|act as|you are now|imagine you)\b/i, 20, "roleplay"],
  ["tool_spoof", /(\bfunction_call|\btool_call|<\/?tool|"name"\s*:\s*"release_funds")/i, 45, "tool_spoof"],
];

// What is scanned: the raw input, the cleaned input in full (n.text is clipped to 8 KB, so padding could push a phrase out
// of it, and rules that need cleaning would then only see the raw spelling), the normalizer's clipped text, and every decoded
// value. The `truncated` flag is deliberately not scored: a long message is not an attack.
export function heuristicScore(n: N, raw: string) {
  const hits: string[] = [];
  let score = 0;
  let technique = "none" as Technique;
  const hit = (name: string, weight: number, t: Technique) => {
    hits.push(name);
    if (weight > score) [score, technique] = [weight, t];
  };
  const hay = [raw, clean(raw), n.text, ...n.decoded.map(d => d.value)].join("\n");
  for (const [name, re, w, t] of RULES) if (re.test(hay)) hit(name, w, t);
  if (n.flags.includes("encoded_payload") && n.flags.includes("tool_name_mention")) hit("encoded_tool", 50, "encoding");
  if (n.flags.includes("zero_width")) hit("zero_width", 25, "encoding");
  return { score: Math.min(score + Math.max(0, hits.length - 1) * 5, 60), hits, technique };
}
