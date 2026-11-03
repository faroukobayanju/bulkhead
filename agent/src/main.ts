// Entry point: builds the real dependencies from env and starts the server. The only file that imports the chain adapters.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import cfgJson from "../config/agent.json";
import { makeViewAccessKey } from "./accesskey";
import { makeAttest } from "./attest";
import { loadConfig, type Config } from "./config";
import { makeDb } from "./db";
import { makeBudget } from "./firewall/budget";
import { makeJudge } from "./firewall/judge";
import { SlidingWindow } from "./firewall/window";
import { loadTierPrompts, makeChat, TIER_MODEL, type Tier } from "./llm";
import { makeNearAI } from "./nearai";
import { makeArenaFirewall } from "./pipeline";
import { RateLimiter } from "./ratelimit";
import { makeAlert, makeServer, type ChainDeps } from "./server";

// Task 9a's adapters (src/chain/vault.ts, btc.ts, base.ts) are loaded here, at runtime and by a computed specifier, so this branch
// type-checks and tests without them. Contract with 9a: vault.ts exports makeChainDeps(cfg, { db, onSettled }) returning the
// ChainDeps of server.ts except viewAccessKey (accesskey.ts owns the login check). onSettled(tier) frees the process-local lock.
async function loadChain(cfg: Config, extra: { db: unknown; onSettled: (t: Tier) => void }): Promise<Omit<ChainDeps, "viewAccessKey">> {
  const spec = "./chain/vault";
  let mod: { makeChainDeps?: (c: Config, x: typeof extra) => Promise<Omit<ChainDeps, "viewAccessKey">> | Omit<ChainDeps, "viewAccessKey"> };
  try {
    mod = await import(spec);
  } catch (e) {
    throw new Error(`chain adapters are not available (src/chain/vault.ts, Task 9a): ${(e as Error).message}`);
  }
  if (typeof mod.makeChainDeps !== "function") throw new Error("src/chain/vault.ts must export makeChainDeps(cfg, { db, onSettled })");
  return mod.makeChainDeps(cfg, extra);
}

export async function start(env: Record<string, string | undefined> = process.env, out: (line: string) => void = console.error) {
  const cfg = loadConfig(env);
  const clock = Date.now;
  const db = makeDb({ fetch, siteUrl: cfg.convexSiteUrl, secret: cfg.agentSecret, pepper: cfg.pepper });
  const alert = makeAlert({ fetch, url: cfg.alertWebhookUrl });
  const log = (event: string, data: Record<string, unknown>) => out(JSON.stringify({ event, ...data }));

  // The chat and judge clients use the models baked into agent.json. An env value that differs would make attestation cover a
  // model the agent does not call, so it is refused rather than honoured.
  for (const t of [1, 2, 3] as const) if (cfg.models[t] !== TIER_MODEL[t]) throw new Error(`TIER_MODEL_${t} differs from the model the agent calls (${TIER_MODEL[t]})`);
  if (cfg.judgeModel !== cfgJson.judge_model) throw new Error(`JUDGE_MODEL differs from the model the agent calls (${cfgJson.judge_model})`);

  const prompts = loadTierPrompts();
  let chat, judge, attest;
  if (cfg.mock) {
    ({ chat, judge, attest } = (await import("./mock")).loadMock());
  } else {
    const client = makeNearAI({ fetch, apiKey: cfg.nearaiApiKey, base: cfg.nearaiBase, prices: cfgJson.prices_usd_per_m, counter: db.counter, clock, dailyUsd: cfg.dailyUsd, onAlert: a => alert("nearai_spend", a) });
    chat = makeChat({ client, prompts: prompts.system, timeoutMs: cfg.llmTimeoutMs });
    judge = makeJudge({ client, model: cfg.judgeModel, timeoutMs: cfg.judgeTimeoutMs });
    attest = makeAttest({ fetch, base: cfg.nearaiBase, apiKey: cfg.nearaiApiKey, models: cfg.models }).get;
  }

  // Verdict signing key. In the TEE it comes from the Shade Agent API (Task 10), which is not wired: until then only a testnet key
  // from env, or a throwaway key in mock mode, can sign.
  const key = cfg.agentPrivateKey ? KeyPair.fromString(cfg.agentPrivateKey as never) : cfg.mock ? KeyPair.fromRandom("ed25519") : null;
  if (!key) throw new Error("no signing key: set AGENT_PRIVATE_KEY (testnet only); the Shade Agent key source is Task 10");

  const viewAccessKey = makeViewAccessKey({ fetch, rpcUrl: cfg.nearRpc || "https://rpc.testnet.near.org" });
  let settled = (_t: Tier) => {};
  let chain: ChainDeps;
  if (cfg.mock && !cfg.vaultAccount) {
    chain = (await import("./mock")).mockChain(viewAccessKey);
  } else {
    chain = { ...(await loadChain(cfg, { db, onSettled: t => settled(t) })), viewAccessKey };
  }

  // Public attempt rows, for ids this process no longer holds: Convex's public query, no secret.
  const getAttempt = async (id: string) => {
    if (!cfg.convexUrl) throw new Error("CONVEX_URL is not set");
    const res = await fetch(`${cfg.convexUrl.replace(/\/+$/, "")}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "attempts:get", args: { id }, format: "json" }), signal: AbortSignal.timeout(10_000) });
    const j: any = await res.json();
    if (!res.ok || j?.status !== "success") throw new Error(`convex query failed: ${res.status}`);
    return (j.value ?? null) as Record<string, any> | null;
  };

  const budget = makeBudget({ counter: db.counter, clock });
  const server = makeServer({
    cfg: {
      network: cfg.network, mock: cfg.mock, btcHrp: cfg.btcHrp, proxySecret: cfg.proxySecret, sessionSecret: cfg.sessionSecret, siteUrl: cfg.siteUrl,
      codehash: cfg.codehash, firewallVersion: cfg.firewallVersion, configSha: createHash("sha256").update(readFileSync(new URL("../config/agent.json", import.meta.url))).digest("hex"),
      models: cfg.models, tierEnabled: cfg.tierEnabled, judgeModel: cfg.judgeModel,
    },
    chain,
    db: Object.assign(db, { getAttempt }),
    chat,
    arenaFirewall: makeArenaFirewall({ budget, judge, timeoutMs: cfg.judgeTimeoutMs }),
    attest,
    promptSha: prompts.sha,
    firewall: {
      judge,
      keys: k => db.apiKeyExists(createHash("sha256").update(k).digest("hex")),
      limiter: new SlidingWindow(),
      budget,
      sign: h => key.sign(h).signature,
      signer: cfg.agentAccount || "mock",
      timeoutMs: cfg.judgeTimeoutMs,
    },
    limiter: new RateLimiter(cfg.rateLimitScale),
    alert,
    log,
  });
  settled = server.onSettled;
  const http = Bun.serve({ port: cfg.port, fetch: server.app.fetch });
  out(JSON.stringify({ event: "listening", port: http.port, mock: cfg.mock, network: cfg.network }));
  return http;
}

if (import.meta.main) {
  start().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
