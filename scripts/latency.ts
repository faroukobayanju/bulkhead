// Spec criterion 9: firewall p95 under 4 s. Sends 100 sequential /v1/check requests built from data/benign-v1.jsonl to a
// deployed agent, prints p50 and p95, exits 1 if p95 is 4000 ms or more.
//   BULKHEAD_KEY=... bun scripts/latency.ts https://<agent-host> [data/benign-v1.jsonl]
import { readFileSync } from "node:fs";

const REQUESTS = 100;
const LIMIT_MS = 4000;
const MIN_GAP_MS = 1100; // 60 calls a minute is the per-key limit; stay under it

// nearest rank
export const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * xs.length) - 1)]!;

type IO = {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  read: (path: string) => string;
  log: (s: string) => void;
};

// Exit codes: 0 passed, 1 failed (slow, or a request did not return 200), 2 could not start.
export async function main(argv: string[], env: Record<string, string | undefined>, io: Partial<IO> = {}): Promise<number> {
  const { fetch: http = fetch, now = () => performance.now(), sleep = ms => new Promise<void>(r => setTimeout(r, ms)), read = (p: string) => readFileSync(p, "utf8"), log = console.log } = io;
  const [base, file = "data/benign-v1.jsonl"] = argv;
  const key = env.BULKHEAD_KEY;
  if (!base || !key) {
    log("usage: BULKHEAD_KEY=... bun scripts/latency.ts <https://agent-host> [benign.jsonl]");
    return 2;
  }
  let messages: string[];
  try {
    messages = read(file).split("\n").filter(l => l.trim()).map(l => JSON.parse(l).message as string);
  } catch (e) {
    log(`cannot read ${file}: ${(e as Error).message}`);
    return 2;
  }
  if (!messages.length) {
    log(`${file} has no messages`);
    return 2;
  }

  const times: number[] = [];
  let degraded = 0;
  let lastStart = -Infinity;
  for (let i = 0; i < REQUESTS; i++) {
    const wait = MIN_GAP_MS - (now() - lastStart);
    if (wait > 0) await sleep(wait);
    lastStart = now();
    const res = await http(`${base.replace(/\/$/, "")}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ messages: [{ role: "user", content: messages[i % messages.length] }] }),
    });
    await res.text();
    times.push(now() - lastStart);
    if (res.status !== 200) {
      log(`request ${i + 1} returned ${res.status}; stopping`);
      return 1;
    }
    if (res.headers.get("x-firewall-degraded") === "1") degraded++;
  }
  const [p50, p95] = [percentile(times, 0.5), percentile(times, 0.95)];
  log(`requests ${times.length}, degraded ${degraded}`);
  log(`p50 ${Math.round(p50)} ms, p95 ${Math.round(p95)} ms`);
  log(p95 < LIMIT_MS ? `PASS: p95 under ${LIMIT_MS} ms` : `FAIL: p95 is ${LIMIT_MS} ms or more`);
  return p95 < LIMIT_MS ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));
