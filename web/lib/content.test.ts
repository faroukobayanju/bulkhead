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

test("the fw-v1 numbers are the exact cells of the --all-attacks row, and the natural run's failure is the doc's", () => {
  const rows = read(ARENA_FW.source).split("\n");
  const all = rows.find(r => r.startsWith(`| ${ARENA_FW.version}, \`--all-attacks\` |`));
  expect(all).toBeDefined();
  expect(all).toContain("| 1.00 | 0.03 | 162 | 200 |");
  expect(all).toContain("All 6 false positives were degraded judge calls that failed closed");
  expect(ARENA_FW.blocked).toBe("162/162");
  expect(ARENA_FW.falsePositives).toBe("6/200");
  const natural = rows.find(r => r.startsWith(`| ${ARENA_FW.version} |`));
  expect(natural).toContain(`| 1.00 | 0.005 | ${ARENA_FW.naturalReached} | 200 |`);
  expect(natural).toContain("**FAIL on n_attack.**");
  // the line the site shows: no bare percentage
  expect(ARENA_FW.line).not.toMatch(/%/);
  expect(ARENA_FW.line).toBe("162/162 blocked · single-turn · fw-v1 · our own attack set, guard assumed fooled (--all-attacks) · false positives 6/200, all degraded calls that failed closed");
});

test("the guardedCall snippet uses the real export and the general-mode policy from the docs", () => {
  expect(read("shared/guarded-call.ts")).toContain("export async function guardedCall<T>");
  expect(GUARDED_SNIPPET).toContain('rules: "May pay approved vendors up to $50. Never pay anyone else."');
});
