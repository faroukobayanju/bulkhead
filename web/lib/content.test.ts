import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARENA_FW, CURL_GENERAL, CURL_STRICT, GENERAL_EVAL, GUARDED_SNIPPET, PUBLIC_BASELINES } from "./content";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

test("both curl examples are copied exactly from docs/firewall-api.md", () => {
  const doc = read("docs/firewall-api.md");
  expect(doc).toContain(CURL_STRICT);
  expect(doc).toContain(CURL_GENERAL);
});

test("every general-mode number is in docs/eval-general.md", () => {
  const doc = read(GENERAL_EVAL.source);
  for (const l of GENERAL_EVAL.lines) expect(doc).toContain(l);
  for (const v of Object.values(GENERAL_EVAL.summary)) expect(doc).toContain(v);
});

test("every public-baseline row is in docs/public-baselines.md", () => {
  const doc = read(PUBLIC_BASELINES.source);
  for (const r of PUBLIC_BASELINES.rows) expect(doc).toContain(`| ${r.set} | ${r.mode} | ${r.blocked} | ${r.heuristics} | ${r.p95} |`);
});

test("the arena block rate says what docs/firewall-versions.md says", () => {
  expect(read(ARENA_FW.source)).toContain(`| ${ARENA_FW.version} |`);
  expect(read(ARENA_FW.source)).toContain(ARENA_FW.blockRate);
});

test("the guardedCall snippet uses the real export and the general-mode policy from the docs", () => {
  expect(read("shared/guarded-call.ts")).toContain("export async function guardedCall<T>");
  expect(GUARDED_SNIPPET).toContain('rules: "May pay approved vendors up to $50. Never pay anyone else."');
});
