// Entry point: builds the real dependencies from env and starts the server. The only file that imports the chain adapters.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import cfgJson from "../config/agent.json";
import { makeViewAccessKey } from "./accesskey";
import { makeAttest } from "./attest";
import { makeChainDeps } from "./chain/vault";
import { trackCompletion } from "./completions";
import { loadConfig } from "./config";
import { makeDb } from "./db";
import { makeBudget } from "./firewall/budget";
import { makeJudge } from "./firewall/judge";
import { SlidingWindow } from "./firewall/window";
import { loadTierPrompts, makeChat, TIER_MODEL, type Tier } from "./llm";
import { makeNearAI } from "./nearai";
import { makeArenaFirewall } from "./pipeline";
import { RateLimiter } from "./ratelimit";
import { makeAlert, makeServer, type ChainDeps } from "./server";

export type Started = { http: ReturnType<typeof Bun.serve>; stop: () => Promise<void>; locks: ReadonlySet<number>; lockedBy: ReadonlyMap<number, string> };

// `o.fetch`, `o.port`, `o.rebroadcastMs` and `o.rebroadcastFirstMs` exist for tests; production passes neither.
export async function start(env: Record<string, string | undefined> = process.env, out: (line: string) => void = console.error, o: { fetch?: typeof fetch; port?: number; rebroadcastMs?: number; rebroadcastFirstMs?: number } = {}): Promise<Started> {
  const cfg = loadConfig(env);
  const f = o.fetch ?? fetch;
  const clock = Date.now;
  const alert = makeAlert({ fetch: f, url: cfg.alertWebhookUrl });
  const log = (event: string, data: Record<string, unknown>) => out(JSON.stringify({ event, ...data }));

  // The chat and judge clients use the models baked into agent.json. An env value that differs would make attestation cover a
  // model the agent does not call, so it is refused rather than honoured.
  for (const t of [1, 2, 3] as const) if (cfg.models[t] !== TIER_MODEL[t]) throw new Error(`TIER_MODEL_${t} differs from the model the agent calls (${TIER_MODEL[t]})`);
  if (cfg.judgeModel !== cfgJson.judge_model) throw new Error(`JUDGE_MODEL differs from the model the agent calls (${cfgJson.judge_model})`);

  // Signing key for verdicts and attempt rows. In the TEE it comes from the Shade Agent API (Task 10), which is not wired: until
  // then only a testnet key from env, or a throwaway key in mock mode, can sign.
  const key = cfg.agentPrivateKey ? KeyPair.fromString(cfg.agentPrivateKey as never) : cfg.mock ? KeyPair.fromRandom("ed25519") : null;
  if (!key) throw new Error("no signing key: set AGENT_PRIVATE_KEY (testnet only); the Shade Agent key source is Task 10");
  const sign = (h: Uint8Array) => key.sign(h).signature;
  const signerId = cfg.agentAccount || "mock";

  const db = makeDb({ fetch: f, siteUrl: cfg.convexSiteUrl, secret: cfg.agentSecret, pepper: cfg.pepper, signer: { id: signerId, sign } });

  const prompts = loadTierPrompts();
  let chat, judge, attest;
  if (cfg.mock) {
    ({ chat, judge, attest } = (await import("./mock")).loadMock());
  } else {
    const att = makeAttest({ fetch: f, base: cfg.nearaiBase, apiKey: cfg.nearaiApiKey, models: cfg.models });
    // E17: every answered call, tier or judge, gets its response signature checked in the background (never inside the judge's
    // race); the attempt's row records whether they all verified.
    const client = makeNearAI({
      fetch: f, apiKey: cfg.nearaiApiKey, base: cfg.nearaiBase, prices: cfgJson.prices_usd_per_m, counter: db.counter, clock, dailyUsd: cfg.dailyUsd,
      onAlert: a => alert("nearai_spend", a),
      onCompletion: trackCompletion(async c => c.id !== null && (await att.verifyCompletion(c.id, c.model, c)).verified),
    });
    chat = makeChat({ client, prompts: prompts.system, timeoutMs: cfg.llmTimeoutMs });
    judge = makeJudge({ client, model: cfg.judgeModel, timeoutMs: cfg.judgeTimeoutMs });
    attest = att.get;
  }

  const viewAccessKey = makeViewAccessKey({ fetch: f, rpcUrl: cfg.nearRpc || "https://rpc.testnet.near.org" });
  let settled = (_t: Tier, _id: string) => {};
  let chain: ChainDeps;
  let startRebroadcast: ((x: { alert: typeof alert; intervalMs?: number; firstMs?: number; warn?: (what: string, id: string, e: unknown) => void }) => (() => void) & { idle: () => Promise<void> }) | undefined;
  let pendingPayouts: (() => Promise<{ id: string; tier: Tier }[]>) | undefined;
  if (cfg.mock && !cfg.vaultAccount) {
    chain = (await import("./mock")).mockChain(viewAccessKey);
  } else {
    const real = makeChainDeps(cfg, { db: db as never, onSettled: (t, id) => settled(t, id), fetch: f });
    chain = { ...real, viewAccessKey };
    startRebroadcast = real.startRebroadcast;
    pendingPayouts = real.pendingPayouts;
    if (!cfg.mock) await real.check(); // BASE_RPC must be the chain the Base tier is on
  }

  // Public attempt rows, for ids this process no longer holds: Convex's public query, no secret.
  const getAttempt = async (id: string) => {
    if (!cfg.convexUrl) throw new Error("CONVEX_URL is not set");
    const res = await f(`${cfg.convexUrl.replace(/\/+$/, "")}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "attempts:get", args: { id }, format: "json" }), signal: AbortSignal.timeout(10_000) });
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
    arenaFirewall: makeArenaFirewall({ budget, judge, timeoutMs: cfg.judgeTimeoutMs, codehash: cfg.codehash, firewallVersion: cfg.firewallVersion }),
    attest,
    promptSha: prompts.sha,
    firewall: {
      judge,
      keys: k => db.apiKeyExists(createHash("sha256").update(k).digest("hex")),
      limiter: new SlidingWindow(),
      budget,
      sign,
      signer: signerId,
      codehash: cfg.codehash,
      firewallVersion: cfg.firewallVersion,
      timeoutMs: cfg.judgeTimeoutMs,
    },
    limiter: new RateLimiter(cfg.rateLimitScale),
    alert,
    log,
  });
  settled = server.onSettled;
  // A payout still in flight from before this start keeps its tier shut: the process-local locks are rebuilt from the rows.
  for (const p of (await pendingPayouts?.()) ?? []) server.adopt(p.tier, p.id);
  const http = Bun.serve({ port: o.port ?? cfg.port, fetch: server.app.fetch });
  // E6: the loop runs in this process, because only this process can free the tier lock. Started after the port is taken, so a
  // failed bind leaves no timer behind.
  const stopRebroadcast = startRebroadcast?.({ alert, intervalMs: o.rebroadcastMs, firstMs: o.rebroadcastFirstMs, warn: (what, id, e) => log(what, { id, error: (e as Error)?.name ?? "unknown" }) });
  out(JSON.stringify({ event: "listening", port: http.port, mock: cfg.mock, network: cfg.network }));
  return {
    http,
    locks: server.locks,
    lockedBy: server.lockedBy,
    stop: async () => {
      stopRebroadcast?.();
      await stopRebroadcast?.idle(); // a run already going finishes before the server is reported stopped
      await http.stop(true);
    },
  };
}

if (import.meta.main) {
  start()
    .then(({ stop }) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void stop().then(() => process.exit(0)));
    })
    .catch(e => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
