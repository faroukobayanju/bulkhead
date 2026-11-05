// `bun run judge` from the repo root: everything a judge can check with no keys, wallet or network (plan E24).
// Runs the agent tests, the local attack demo, and the contract tests when cargo, cargo-near and docker are installed.
// Exit 0 only if everything that ran passed.
import { fileURLToPath } from "node:url";

type Run = (cmd: string[], cwd: string) => Promise<number>;
type IO = { log: (s: string) => void; run: Run; has: (bin: string) => boolean };

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const ROOT = path("..");
const AGENT = path("../agent");
const run: Run = (cmd, cwd) => Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;

export async function main(io: Partial<IO> = {}): Promise<number> {
  const { log = console.log, run: exec = run, has = (b: string) => Bun.which(b) !== null } = io;
  log("Bulkhead judge check. The attack demo uses a mock model (MOCK_LLM fixtures), not NEAR AI: nothing here calls a model or a chain.");
  log("Live evidence (testnet and mainnet transactions, measured block rates) is in docs/claims.md.");
  const bun = process.execPath;
  const steps: [name: string, cmd: string[], cwd: string][] = [
    ["agent tests", [bun, "test"], AGENT],
    ["attack demo (--local)", [bun, path("attack-demo.ts"), "--local"], ROOT],
  ];
  const missing = ["cargo", "cargo-near", "docker"].filter(b => !has(b));
  if (!missing.length) steps.push(["contract tests", ["bash", path("test-contracts.sh")], ROOT]);

  const results: string[] = [];
  for (const [name, cmd, cwd] of steps) {
    log(`\n== ${name}`);
    const code = await exec(cmd, cwd);
    results.push(`${code === 0 ? "PASS" : "FAIL"}  ${name}${code === 0 ? "" : ` (exit ${code})`}`);
  }
  if (missing.length) results.push(`SKIP  contract tests: skipped, ${missing.join(", ")} not found (they need Rust, cargo-near and Docker)`);
  log("\n== results");
  for (const r of results) log(r);
  return results.some(r => r.startsWith("FAIL")) ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
