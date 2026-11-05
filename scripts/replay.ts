// The replay benchmark: runs the current tier-3 firewall over every tier 1 and 2 attempt where the model called the tool, and stores
// one verdict per attempt and firewall version in `replays`. Meant to run hourly in the CVM with the agent's env.
//   LIVE=1 bun scripts/replay.ts --max-usd 0.50
// Real, billed judge calls: refuses without LIVE=1 and a --max-usd limit on this run's spend. The spend also counts toward the
// agent's daily NEARAI_DAILY_USD cap. Every checkpoint takes one call off the arena pool that tier 3 uses (E10), and a run stops once
// half of that pool is used, so replay cannot take tier 3 offline.
import agentConfig from "../agent/config/agent.json";
import { ConfigError, loadConfig, type Config } from "../agent/src/config";
import { utcDay, type Counter } from "../agent/src/counter";
import { makeDb } from "../agent/src/db";
import type { FirewallResult, Judge } from "../agent/src/firewall/api";
import { LIMITS, makeBudget } from "../agent/src/firewall/budget";
import { makeJudge } from "../agent/src/firewall/judge";
import { makeNearAI, NearAIError } from "../agent/src/nearai";
import { BudgetExhaustedError, BudgetUnavailableError, makeArenaFirewall } from "../agent/src/pipeline";
import { makeAlert } from "../agent/src/server";

type IO = { fetch: typeof fetch; log: (s: string) => void; judge: Judge }; // judge: tests only

// Exit codes: 0 ran (stopping on a spend limit or at half the arena pool included), 1 a degraded verdict or an exhausted arena pool, 2 refused.
export async function main(argv: string[], env: Record<string, string | undefined>, io: Partial<IO> = {}): Promise<number> {
  const { fetch: http = fetch, log = console.log } = io;
  if (env.LIVE !== "1") return refuse(log, "this makes real, billed NEAR AI calls. Set LIVE=1 to run it.");
  const at = argv.indexOf("--max-usd");
  const maxUsd = at >= 0 && argv[at + 1] !== undefined ? Number(argv[at + 1]) : NaN;
  if (!(maxUsd > 0 && Number.isFinite(maxUsd))) return refuse(log, "pass a spending limit as --max-usd <n> (a positive number of dollars).");
  let cfg: Config;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return refuse(log, e.message);
    throw e;
  }
  if (!io.judge && !cfg.nearaiApiKey) return refuse(log, "NEARAI_API_KEY is not set: replay needs the real judge, so MOCK_LLM must be off.");

  const db = makeDb({ fetch: http, siteUrl: cfg.convexSiteUrl, secret: cfg.agentSecret, pepper: cfg.pepper });
  let mine = 0; // micro-USD this run has added to the day's NEAR AI spend
  let halt: string | null = null; // why the judge was not called
  let judge = io.judge;
  if (!judge) {
    // Spend goes on the agent's own daily count, under its NEARAI_DAILY_USD cap and alert. This run's share is tallied for --max-usd.
    const counter: Counter = {
      get: k => db.counter.get(k),
      async add(k, n, cap) {
        const r = await db.counter.add(k, n, cap);
        if (r !== null && k.startsWith("nearai:spend:")) mine += n;
        return r;
      },
    };
    const alert = makeAlert({ fetch: http, url: cfg.alertWebhookUrl });
    const ai = makeNearAI({ fetch: http, apiKey: cfg.nearaiApiKey, base: cfg.nearaiBase, prices: agentConfig.prices_usd_per_m, counter, clock: Date.now, dailyUsd: cfg.dailyUsd, onAlert: a => alert("nearai_spend", a) });
    const real = makeJudge({ client: ai, model: cfg.judgeModel, timeoutMs: cfg.judgeTimeoutMs });
    // Checked before every judge call, so a run passes --max-usd by at most one call. checkFirewall turns any judge error into a
    // degraded block, so the reason is kept here for the loop to see.
    judge = async (input, signal) => {
      if (mine >= maxUsd * 1e6) throw new Error((halt = `estimated spend reached --max-usd ${maxUsd}`));
      try {
        return await real(input, signal);
      } catch (e) {
        if (e instanceof NearAIError && e.code === "spend_cap") halt = "the agent's daily NEAR AI cap (NEARAI_DAILY_USD) is reached";
        throw e;
      }
    };
  }
  // the same firewall, version and codehash as live tier 3
  const firewall = makeArenaFirewall({ budget: makeBudget({ counter: db.counter, clock: Date.now }), judge, timeoutMs: cfg.judgeTimeoutMs, codehash: cfg.codehash, firewallVersion: cfg.firewallVersion });

  let replayed = 0, blocked = 0, degraded = 0, stopped = false;
  let cursor: string | null = null;
  try {
    pages: for (;;) {
      const page = await db.replayTodo(cfg.firewallVersion, cursor);
      for (const row of page.rows) {
        // replay shares the arena pool with tier 3: past half of it, the rest is left for players
        if ((await db.counter.get(`fw:arena:${utcDay(Date.now())}`)) >= LIMITS.arena / 2) {
          log(`stopping: half of today's arena pool (${LIMITS.arena / 2} of ${LIMITS.arena} calls) is used; the rest is kept for tier 3`);
          break pages;
        }
        // as tier 3 runs it: A on the message; only if A allows, B with the release the model proposed
        const messages = [{ role: "user" as const, content: row.message }];
        let r: FirewallResult = await firewall({ messages });
        if (!r.degraded && r.verdict === "allow") r = await firewall({ messages, proposed_action: { tool: "release_funds", args: { recipient: row.payout_address } } });
        if (r.degraded) {
          if (halt) {
            log(`stopping: ${halt}`);
            break pages;
          }
          // a judge that did not judge is not a verdict, and the first stored verdict stands for good: leave it for the next run
          degraded++;
          continue;
        }
        await db.insertReplay({ attempt_id: row.id, fw_version: cfg.firewallVersion, verdict: r.verdict, risk: r.risk });
        replayed++;
        if (r.verdict !== "allow") blocked++;
      }
      if (page.done) break;
      cursor = page.next;
    }
  } catch (e) {
    if (!(e instanceof BudgetExhaustedError || e instanceof BudgetUnavailableError)) throw e;
    log(`stopping: the arena budget is ${e instanceof BudgetExhaustedError ? "used up for today" : "unreadable"}`);
    stopped = true;
  }
  log(`replayed ${replayed}, blocked ${blocked}, degraded ${degraded} (${cfg.firewallVersion})`);
  if (!io.judge) log(`estimated spend this run $${(mine / 1e6).toFixed(6)} of --max-usd ${maxUsd}`);
  return degraded || stopped ? 1 : 0;
}

function refuse(log: (s: string) => void, why: string) {
  log(`refusing to run: ${why}`);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));
