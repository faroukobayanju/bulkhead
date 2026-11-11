// Entry point: builds the real dependencies from env and starts the server. The only file that imports the chain adapters.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import cfgJson from "../config/agent.json";
import { makeViewAccessKey } from "./accesskey";
import { makeAttest } from "./attest";
import { keySigner, makeChainDeps, type Signer } from "./chain/vault";
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
import { bootTee, startRenewal } from "./tee";
import { startRootsPoster } from "./roots";
import { buildDay } from "../../scripts/export-dataset";

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

  // Signing key for verdicts, attempt rows and vault calls: a testnet key from env, or a throwaway key in mock mode. In the TEE
  // the agent makes its own account and keeps only a vault-scoped key (src/tee.ts), set below once every check has passed.
  let key = cfg.agentPrivateKey ? KeyPair.fromString(cfg.agentPrivateKey as never) : cfg.mock ? KeyPair.fromRandom("ed25519") : null;
  if (!key && !cfg.tee) throw new Error("no signing key: set AGENT_PRIVATE_KEY (testnet only) or run in the TEE with TEE=1");
  let signerId = cfg.agentAccount || "mock";
  const sign = (h: Uint8Array) => key!.sign(h).signature;

  const db = makeDb({ fetch: f, siteUrl: cfg.convexSiteUrl, secret: cfg.agentSecret, pepper: cfg.pepper, signer: { get id() { return signerId; }, sign } });

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
  let pending: { id: string; tier: Tier }[] = [];
  let tee: Awaited<ReturnType<typeof bootTee>> | null = null;
  let real: ReturnType<typeof makeChainDeps> | undefined;
  if (cfg.mock && !cfg.vaultAccount) {
    chain = (await import("./mock")).mockChain(viewAccessKey);
  } else {
    const build = (account: string, signer?: Signer) => makeChainDeps({ ...cfg, agentAccount: account }, { signer, db: db as never, onSettled: (t, id) => settled(t, id), fetch: f, warn: (what, id, e) => log(what, { id, error: (e as Error)?.name ?? "unknown" }) });
    // Every check that needs no signature runs before the TEE key swap, so a bad deployment fails before an account is funded.
    // In the TEE these reads go through a vault whose throwaway key never sends.
    const pre = build(signerId, cfg.tee ? keySigner(KeyPair.fromRandom("ed25519").toString()) : undefined);
    // The agent account may hold only vault-scoped keys (scripts/check-agent-key.ts). bootTee checks its own account.
    if (!cfg.mock && !cfg.tee && !(await pre.keysScoped())) throw new Error(`agent account ${signerId} has keys not scoped to ${cfg.vaultAccount}: refusing to serve`);
    if (!cfg.mock) await pre.check(); // BASE_RPC must be the chain the Base tier is on
    pending = await pre.pendingPayouts();
    if (cfg.tee) {
      tee = await bootTee({ fetch: f, rpcUrl: cfg.nearRpc, vault: cfg.vaultAccount, log: out });
      key = tee.key;
      signerId = tee.account;
      real = build(signerId, keySigner(tee.key.toString()));
    } else real = pre;
    chain = { ...real, viewAccessKey };
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
      models: cfg.models, tierEnabled: cfg.tierEnabled, judgeModel: cfg.judgeModel, agentAccount: signerId, tee: cfg.tee,
    },
    chain,
    db: Object.assign(db, { getAttempt }),
    chat,
    arenaFirewall: makeArenaFirewall({ budget, judge, timeoutMs: cfg.judgeTimeoutMs, codehash: cfg.codehash, firewallVersion: cfg.firewallVersion, generalVersion: cfg.firewallGeneralVersion }),
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
      generalVersion: cfg.firewallGeneralVersion,
      timeoutMs: cfg.judgeTimeoutMs,
    },
    limiter: new RateLimiter(cfg.rateLimitScale),
    alert,
    log,
  });
  settled = server.onSettled;
  // A payout still in flight from before this start keeps its tier shut: the process-local locks are rebuilt from the rows.
  for (const p of pending) server.adopt(p.tier, p.id);
  const http = Bun.serve({ port: o.port ?? cfg.port, fetch: server.app.fetch });
  // E6: the loop runs in this process, because only this process can free the tier lock. Started after the port is taken, so a
  // failed bind leaves no timer behind.
  const stopRebroadcast = real?.startRebroadcast({ alert, intervalMs: o.rebroadcastMs, firstMs: o.rebroadcastFirstMs, warn: (what, id, e) => log(what, { id, error: (e as Error)?.name ?? "unknown" }) });
  const stopRenewal = tee && real ? startRenewal({ fetch: f, account: tee.account, register: real.registerAgent, funds: real.funds, log: out, alert }) : undefined;
  // The day's roots, with the agent's own key: in the TEE nothing else can post them. Live testnet too; the script's
  // --post-roots run and this one agree, since a day already holding the same roots counts as done.
  const stopRoots = real && !cfg.mock ? startRootsPoster({ build: d => buildDay(db, d), vault: real, log, alert }) : undefined;
  out(JSON.stringify({ event: "listening", port: http.port, mock: cfg.mock, network: cfg.network }));
  return {
    http,
    locks: server.locks,
    lockedBy: server.lockedBy,
    stop: async () => {
      stopRenewal?.();
      stopRoots?.();
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
