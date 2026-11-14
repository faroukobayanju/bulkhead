import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../scripts/judge";

function rig(o: { fail?: string; bins?: string[] } = {}) {
  const out: string[] = [];
  const ran: { cmd: string[]; cwd: string }[] = [];
  const run = async (cmd: string[], cwd: string) => (ran.push({ cmd, cwd }), o.fail && cmd.join(" ").includes(o.fail) ? 1 : 0);
  const has = (bin: string) => (o.bins ?? []).includes(bin);
  return { out, ran, text: () => out.join("\n"), io: { log: (s: string) => void out.push(s), run, has } };
}

describe("bun run judge", () => {
  test("says the demo uses a mock model, what it needs, and points to docs/claims.md, before running anything", async () => {
    const r = rig();
    await main(r.io);
    const head = r.out.slice(0, 2).join("\n");
    expect(head).toMatch(/mock model/i);
    expect(head).toMatch(/no keys or wallet; the first run downloads packages and the contract sandbox/i);
    expect(head).toContain("docs/claims.md");
    expect(head).not.toMatch(/no network/i);
  });

  test("runs the agent tests, the deploy script tests and the local attack demo with absolute paths; skips contracts without cargo and docker", async () => {
    const r = rig();
    expect(await main(r.io)).toBe(0);
    expect(r.ran).toHaveLength(3);
    const [tests, deploy, demo] = r.ran;
    expect(tests!.cmd.slice(-1)).toEqual(["test"]);
    expect(tests!.cwd.endsWith("/agent")).toBe(true);
    expect(existsSync(tests!.cwd)).toBe(true);
    expect(existsSync(join(deploy!.cwd, deploy!.cmd.at(-1)!))).toBe(true);
    expect(deploy!.cmd.at(-1)).toBe("./test/vault-deploy.test.ts");
    expect(demo!.cmd.slice(-2)[1]).toBe("--local");
    expect(existsSync(demo!.cmd.slice(-2)[0]!)).toBe(true);
    expect(r.text()).toMatch(/contract tests.*skipped.*cargo/i);
    expect(r.text()).toMatch(/PASS.*agent tests/);
    expect(r.text()).toMatch(/PASS.*deploy script tests/);
  });

  test("runs the contract tests when cargo, cargo-near and docker are found", async () => {
    const r = rig({ bins: ["cargo", "cargo-near", "docker"] });
    expect(await main(r.io)).toBe(0);
    expect(r.ran).toHaveLength(4);
    expect(existsSync(r.ran[3]!.cmd.at(-1)!)).toBe(true);
    expect(r.ran[3]!.cmd.at(-1)!.endsWith("scripts/test-contracts.sh")).toBe(true);
  });

  test("names what is missing when it skips the contracts", async () => {
    const r = rig({ bins: ["cargo", "cargo-near"] });
    await main(r.io);
    expect(r.text()).toMatch(/skipped.*docker/i);
  });

  test("any failure is a FAIL line and exit 1, and the rest still run", async () => {
    const r = rig({ fail: "attack-demo" });
    expect(await main(r.io)).toBe(1);
    expect(r.text()).toMatch(/FAIL.*attack demo/i);
    expect(r.ran).toHaveLength(3);
  });
});
