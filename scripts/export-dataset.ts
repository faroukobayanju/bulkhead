// The nightly dataset export (E7, E20): one UTC day of attempts as JSONL plus that day's hourly Merkle roots, then, with
// --post-roots, the roots on-chain with log_attempt_roots (once per day). Runs with the agent's env, after midnight UTC.
//   bun scripts/export-dataset.ts [--date YYYY-MM-DD] [--post-roots]      (default: yesterday)
// Every row's stored leaf is recomputed first; one that differs stops the export and names the attempt.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, type Config } from "../agent/src/config";
import { makeChainDeps } from "../agent/src/chain/vault";
import { makeDb, type Db } from "../agent/src/db";
import { attemptView, type ViewInput } from "../shared/attempt-view";
import { attemptLeaf, isoMs, type LeafInput } from "../shared/leaf";
import { epochDay, hourlyRoots } from "../shared/merkle";
import { DATASET_DIR } from "./verify-roots";

const DAY_MS = 86_400_000;
const GRACE_MS = 5 * 60_000; // a row's ts is taken just before its insert: wait a little past midnight so the last ones are in
const HEX64 = /^[0-9a-f]{64}$/;

type RootsVault = { getRoots(day: number): Promise<[number, string][]>; logAttemptRoots(day: number, roots: [number, string][]): Promise<void> };
type IO = { fetch: typeof fetch; log: (s: string) => void; now: () => number; dir: string; db: Pick<Db, "listAttempts">; vault: RootsVault };

const FW_KEYS = ["verdict", "risk", "technique", "reason", "firewall_version", "codehash", "latency_ms", "degraded"] as const;
const fw = (x: Record<string, unknown> | null | undefined) => (x ? Object.fromEntries(FW_KEYS.map(k => [k, x[k]])) : null);

// The public columns, picked one by one: a new column stays out until it is added here. Never ip_hash; account_hash is the peppered
// hash. Left out on purpose: the raw payout_address (only a winner's, shortened, as `payout`, like the public view), stage, and the
// recovery state (release_tx, release_ref_height, settled_at). Hidden rows stay in, with `hidden: true`. Firewall reasons are in.
export function toExportRow(r: Record<string, any>) {
  return {
    id: r.id,
    ts: r.ts,
    tier: r.tier,
    account_hash: r.account_hash,
    message: r.message, // player text, published by consent
    normalized: r.normalized,
    outcome: r.outcome,
    technique: r.technique ?? null,
    tool_called: r.tool_called,
    fw_a: fw(r.fw_a),
    fw_b: fw(r.fw_b),
    llm_output: r.llm_output ?? null,
    reply: r.reply,
    payout: attemptView(r as ViewInput).payout,
    prompt_sha256: r.prompt_sha256,
    model_id: r.model_id,
    attestation_sha256: r.attestation_sha256,
    codehash: r.codehash,
    near_tx: r.near_tx ?? null,
    chain_txid: r.chain_txid ?? null,
    consent_version: r.consent_version,
    response_verified: r.response_verified ?? null,
    signature: r.signature ?? null,
    signer: r.signer ?? null,
    hidden: r.hidden,
    leaf: r.leaf,
  };
}

// Exit codes: 0 done, 1 failed (a leaf, the account check, Convex or the chain), 2 refused to run.
export async function main(argv: string[], env: Record<string, string | undefined>, io: Partial<IO> = {}): Promise<number> {
  const { fetch: http = fetch, log = console.log, now = Date.now, dir = DATASET_DIR } = io;
  const at = argv.indexOf("--date");
  const date = at >= 0 ? (argv[at + 1] ?? "") : isoMs(now() - DAY_MS).slice(0, 10);
  let day: number;
  try {
    day = epochDay(date);
  } catch (e) {
    return refuse(log, (e as Error).message);
  }
  const start = day * DAY_MS;
  if (now() < start + DAY_MS + GRACE_MS) return refuse(log, `${date} is not over yet; export it after ${isoMs(start + DAY_MS + GRACE_MS)}`);
  const post = argv.includes("--post-roots");

  let cfg: Config;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return refuse(log, e.message);
    throw e;
  }
  const db = io.db ?? makeDb({ fetch: http, siteUrl: cfg.convexSiteUrl, secret: cfg.agentSecret, pepper: cfg.pepper });
  let vault = io.vault;
  if (post && !vault) {
    if (!cfg.vaultAccount) return refuse(log, "--post-roots needs VAULT_ACCOUNT");
    try {
      vault = makeChainDeps(cfg, { db: db as never, onSettled: () => {}, fetch: http });
    } catch (e) {
      return refuse(log, `--post-roots: ${(e as Error).message}`);
    }
  }

  // the export pages in ts order from `since`, past the end of the day: stop at the first row of the next day
  const since = isoMs(start), until = isoMs(start + DAY_MS);
  const rows: Record<string, any>[] = [];
  for (let cursor: string | null = null; ; ) {
    const page = await db.listAttempts(since, cursor, 500);
    rows.push(...page.rows.filter(r => (r.ts as string) < until));
    if (page.done || page.rows.some(r => (r.ts as string) >= until)) break;
    cursor = page.next;
  }

  for (const r of rows) {
    let leaf: string | null = null;
    try {
      leaf = attemptLeaf(r as LeafInput);
    } catch {}
    if (leaf !== r.leaf) {
      log(`leaf mismatch: attempt ${r.id} does not hash to its stored leaf. Nothing was written.`);
      return 1;
    }
  }
  const out = rows.map(toExportRow);
  // Spec criterion 14: a raw account name must never be published. Anything that is not a sha256 fails, which covers any *.near or *.testnet.
  const raw = out.filter(r => typeof r.account_hash !== "string" || !HEX64.test(r.account_hash));
  if (raw.length) {
    log(`account check failed: account_hash is not a sha256 on ${raw.map(r => r.id).join(", ")}. Nothing was written.`);
    return 1;
  }
  const roots = hourlyRoots(date, out as unknown as LeafInput[]);

  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `attempts-${date}.jsonl`);
  const rootsFile = join(dir, `roots-${date}.json`);
  writeFileSync(jsonl, out.map(r => JSON.stringify(r) + "\n").join(""));
  writeFileSync(rootsFile, JSON.stringify(Object.fromEntries(roots), null, 2) + "\n");
  // ponytail: pushing these to the public data repo (with DATASET_DEPLOY_KEY) is not built; commit and push the two files by hand
  log(`wrote ${out.length} rows in ${roots.length} hours:\n  ${jsonl}\n  ${rootsFile}`);

  if (!post) return 0;
  if (!roots.length) {
    log(`no attempts on ${date}: no roots to post`);
    return 0;
  }
  // Each day can be written once. Roots already there are fine only if they are ours.
  const same = (x: [number, string][]) => JSON.stringify(x) === JSON.stringify(roots);
  const before = await vault!.getRoots(day);
  if (before.length) {
    if (same(before)) {
      log(`roots for ${date} (day ${day}) are already on-chain and match`);
      return 0;
    }
    log(`roots for ${date} (day ${day}) on-chain differ from this export`);
    return 1;
  }
  try {
    await vault!.logAttemptRoots(day, roots);
  } catch (e) {
    // ERR_ROOTS_EXIST from a run in between, or a tx that landed after the wait gave up: done only if what is there is ours
    if (!same(await vault!.getRoots(day))) {
      log(`posting roots for ${date} failed: ${(e as Error).message}`);
      return 1;
    }
  }
  log(`posted ${roots.length} roots for ${date} (day ${day})`);
  return 0;
}

function refuse(log: (s: string) => void, why: string) {
  log(`refusing to run: ${why}`);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));
