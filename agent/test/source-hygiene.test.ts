import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invisible characters in source hide in diffs and in string literals. Write them as \u escapes.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

test("no source file contains a literal invisible character", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = ["agent/src/**/*.ts", "agent/test/**/*.ts", "shared/*.ts", "scripts/*.ts", "convex/**/*.ts"].flatMap(g => [...new Glob(g).scanSync({ cwd: root })]);
  expect(files.length).toBeGreaterThan(20);
  const bad = files.filter(f => INVISIBLE.test(readFileSync(root + f, "utf8")));
  expect(bad).toEqual([]);
});
