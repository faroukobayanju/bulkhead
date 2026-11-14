// Checks a day of the public dataset against the roots the agent wrote on-chain (E7). Needs no keys and no account.
//   bun run scripts/verify-roots.ts 2026-11-10 [--rpc <url>] [--vault <account>]
// Recomputes every leaf from its row in dataset/attempts-<date>.jsonl, rebuilds each hour's Merkle root, reads get_roots(day) from
// the vault and exits 0 only if every hour matches exactly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LeafInput } from "../shared/leaf";
import { epochDay, hourlyRoots } from "../shared/merkle";

// Kept free of agent imports, so a verifier loads nothing but shared/.
export const DATASET_DIR = fileURLToPath(new URL("../dataset/", import.meta.url));
export const MAINNET_RPC = "https://rpc.mainnet.near.org";
// No mainnet vault is deployed yet. Until one is, this placeholder makes the script ask for --vault instead of guessing.
export const MAINNET_VAULT = "MAINNET-VAULT-NOT-DEPLOYED";

type IO = { fetch: typeof fetch; log: (s: string) => void; dir: string };

const opt = (argv: string[], name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function getRoots(http: typeof fetch, rpc: string, vault: string, day: number): Promise<[number, string][]> {
  const res = await http(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "verify-roots", method: "query", params: { request_type: "call_function", finality: "final", account_id: vault, method_name: "get_roots", args_base64: Buffer.from(JSON.stringify({ day })).toString("base64") } }),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await res.json();
  if (j?.error) throw new Error(j.error.cause?.name ?? j.error.name ?? "rpc error");
  if (typeof j?.result?.error === "string") throw new Error(j.result.error.slice(0, 200));
  return JSON.parse(Buffer.from(j.result.result).toString());
}

// Exit codes: 0 every hour matches, 1 not verified, 2 bad arguments.
export async function main(argv: string[], _env: Record<string, string | undefined> = {}, io: Partial<IO> = {}): Promise<number> {
  const { fetch: http = fetch, log = console.log, dir = DATASET_DIR } = io;
  const date = argv[0] ?? "";
  let day: number;
  try {
    day = epochDay(date);
  } catch (e) {
    log(`usage: bun run scripts/verify-roots.ts <YYYY-MM-DD> [--rpc <url>] [--vault <account>]\n${(e as Error).message}`);
    return 2;
  }
  const rpc = opt(argv, "--rpc") ?? MAINNET_RPC;
  const vault = opt(argv, "--vault") ?? MAINNET_VAULT;
  if (vault === MAINNET_VAULT) {
    log("no mainnet vault is deployed yet: pass the vault account with --vault <account> (and --rpc for testnet)");
    return 2;
  }

  let local: [number, string][];
  const file = join(dir, `attempts-${date}.jsonl`);
  try {
    const rows = readFileSync(file, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as LeafInput);
    local = hourlyRoots(date, rows);
  } catch (e) {
    log(`could not read ${file}: ${(e as Error).message}`);
    return 1;
  }
  let chain: [number, string][];
  try {
    chain = await getRoots(http, rpc, vault, day);
  } catch (e) {
    log(`could not read get_roots(${day}) from ${vault}: ${(e as Error).message}`);
    return 1;
  }

  const mine = new Map(local), theirs = new Map(chain);
  const hours = [...new Set([...mine.keys(), ...theirs.keys()])].sort((a, b) => a - b);
  let bad = 0;
  log(`${date} is day ${day}; vault ${vault} at ${rpc}`);
  for (const h of hours) {
    const a = mine.get(h), b = theirs.get(h);
    const label = `hour ${String(h).padStart(2, "0")}`;
    if (a === b) log(`${label}  ok         ${a}`);
    else {
      bad++;
      if (b === undefined) log(`${label}  missing on-chain   file ${a}`);
      else if (a === undefined) log(`${label}  missing in the file   chain ${b}`);
      else log(`${label}  MISMATCH   file ${a}  chain ${b}`);
    }
  }
  log(bad ? `NOT VERIFIED: ${bad} of ${hours.length} hours differ` : `verified: all ${hours.length} hours match`);
  return bad ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));
