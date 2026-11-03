// Startup config from env, validated all at once: a bad deployment lists every problem and does not start (E4, E20, E22).
// Non-secret defaults (NEAR AI base URL, models) come from the baked agent.json, so env can only repeat them.
import { Buffer } from "node:buffer";
import cfg from "../config/agent.json";
import { rateLimitScale } from "./ratelimit";
import { dailyLimitUsd } from "./nearai";

export type Hrp = "bc" | "tb";
export type Config = {
  network: "testnet" | "mainnet";
  mock: boolean;
  nearRpc: string;
  vaultAccount: string;
  agentAccount: string;
  agentPrivateKey: string | undefined;
  nearaiBase: string;
  nearaiApiKey: string;
  models: { 1: string; 2: string; 3: string };
  judgeModel: string;
  convexUrl: string | undefined;
  convexSiteUrl: string;
  agentSecret: string;
  pepper: string;
  sessionSecret: string;
  proxySecret: string;
  mempoolBase: string;
  baseRpc: string;
  tierEnabled: { 1: boolean; 2: boolean; 3: boolean };
  codehash: string;
  firewallVersion: string;
  siteUrl: string;
  alertWebhookUrl: string | undefined;
  rateLimitScale: number;
  dailyUsd: number;
  llmTimeoutMs: number;
  judgeTimeoutMs: number;
  port: number;
  btcHrp: Hrp;
};

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`bad config:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

// name, when it is needed, what it is. .env.example is generated from this (envExample) and a test keeps the file in step.
export const ENV_DOC: readonly (readonly [name: string, need: string, what: string])[] = [
  ["NEAR_NETWORK", "required", "testnet or mainnet"],
  ["NEAR_RPC", "required unless MOCK_LLM", "NEAR JSON-RPC URL"],
  ["VAULT_ACCOUNT", "required unless MOCK_LLM", "the vault contract account, e.g. bulkhead-vault.<team>.testnet"],
  ["AGENT_ACCOUNT", "required unless MOCK_LLM", "the agent's NEAR account (the verdict signer)"],
  ["AGENT_PRIVATE_KEY", "testnet only", "ed25519:... key of the agent; in the TEE it comes from the Shade Agent API, never from env"],
  ["NEARAI_BASE", "optional", "NEAR AI gateway, defaults to config/agent.json (https://cloud-api.near.ai/v1)"],
  ["NEARAI_API_KEY", "required unless MOCK_LLM", "NEAR AI Cloud key, with a spending limit set in its dashboard"],
  ["TIER_MODEL_1", "optional", "tier 1 model, defaults to config/agent.json and must equal the model the agent calls"],
  ["TIER_MODEL_2", "optional", "tier 2 model, same rule"],
  ["TIER_MODEL_3", "optional", "tier 3 model, same rule"],
  ["JUDGE_MODEL", "optional", "firewall judge model, defaults to config/agent.json"],
  ["CONVEX_URL", "optional", "Convex deployment URL (the web app uses it; the agent does not)"],
  ["CONVEX_SITE_URL", "required", "Convex site URL that serves POST /agent/<op>; https unless local"],
  ["AGENT_SECRET", "required", "32+ bytes, equal to the Convex env var of the same name"],
  ["PEPPER", "required", "32+ random bytes; hashes account and IP before they reach Convex"],
  ["SESSION_SECRET", "required", "32+ random bytes; signs login sessions"],
  ["PROXY_SECRET", "required", "32+ bytes shared with the web proxy (x-bulkhead-proxy-secret)"],
  ["MEMPOOL_BASE", "required unless MOCK_LLM", "mempool API, https://mempool.space/testnet4/api or https://mempool.space/api"],
  ["BASE_RPC", "required unless MOCK_LLM, when tier 2 is on", "Base JSON-RPC URL"],
  ["TIER_ENABLED_1", "optional", "1 (default) or 0"],
  ["TIER_ENABLED_2", "optional", "1 (default) or 0"],
  ["TIER_ENABLED_3", "optional", "1 (default) or 0"],
  ["CODEHASH", "required on mainnet", "measured image hash reported by /attestation; testnet and mock default to local"],
  ["FIREWALL_VERSION", "required on mainnet", "firewall version reported in every verdict; testnet and mock default to fw-v1"],
  ["SITE_URL", "required on mainnet", "public site, the base of docs_url in error bodies"],
  ["ALERT_WEBHOOK_URL", "optional", "https URL that receives operator alerts; unset means no alerts"],
  ["DATASET_DEPLOY_KEY", "export job only", "Convex deploy key used by the dataset export, never by the agent"],
  ["MOCK_LLM", "optional, testnet only", "1 replaces NEAR AI chat, the judge and attestation with canned fixtures"],
  ["RATE_LIMIT_SCALE", "optional, testnet only", "number in (0, 1] that shortens every rate-limit window"],
  ["NEARAI_DAILY_USD", "optional", "daily NEAR AI spend cap in USD, default 5"],
  ["LLM_TIMEOUT_MS", "optional", "tier agent call timeout, default 20000"],
  ["JUDGE_TIMEOUT_MS", "optional", "judge call timeout, default 3500"],
  ["PORT", "optional", "listen port, default 8787"],
];
export const envExample = () => ENV_DOC.map(([name, need, what]) => `# ${what} (${need})\n${name}=`).join("\n\n") + "\n";

const MIN_SECRET = 32;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const bad: string[] = [];
  const get = (k: string) => (env[k]?.trim() ? env[k]!.trim() : undefined);
  const need = (k: string, on = true) => {
    const v = get(k);
    if (v === undefined && on) bad.push(`${k} is required`);
    return v ?? "";
  };
  const secret = (k: string) => {
    const v = need(k);
    if (v && Buffer.byteLength(v) < MIN_SECRET) bad.push(`${k} must be at least ${MIN_SECRET} bytes`);
    return v;
  };
  const posInt = (k: string, dflt: number) => {
    const raw = get(k);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) bad.push(`${k} must be a positive integer, got "${raw}"`);
    return n > 0 ? n : dflt;
  };
  const url = (k: string, v: string, https: boolean) => {
    if (!v) return;
    try {
      const u = new URL(v);
      if (https && u.protocol !== "https:") bad.push(`${k} must be an https URL`);
      else if (!/^https?:$/.test(u.protocol)) bad.push(`${k} must be an http(s) URL`);
    } catch {
      bad.push(`${k} must be a URL`);
    }
  };

  const nw = get("NEAR_NETWORK");
  if (nw !== "testnet" && nw !== "mainnet") bad.push(`NEAR_NETWORK must be testnet or mainnet, got "${nw ?? ""}"`);
  const network = nw === "mainnet" ? "mainnet" : "testnet";
  const mockRaw = get("MOCK_LLM");
  if (mockRaw !== undefined && mockRaw !== "0" && mockRaw !== "1") bad.push(`MOCK_LLM must be 0 or 1, got "${mockRaw}"`);
  const mock = mockRaw === "1";
  if (mock && nw !== "testnet") bad.push("MOCK_LLM is only allowed when NEAR_NETWORK=testnet");
  const live = !mock;
  const dev = mock || nw === "testnet";

  let scale = 1;
  try {
    scale = rateLimitScale({ RATE_LIMIT_SCALE: get("RATE_LIMIT_SCALE"), NEAR_NETWORK: nw });
  } catch (e) {
    bad.push((e as Error).message);
  }
  let dailyUsd = 5;
  try {
    dailyUsd = dailyLimitUsd({ NEARAI_DAILY_USD: get("NEARAI_DAILY_USD") });
  } catch (e) {
    bad.push((e as Error).message);
  }

  const key = get("AGENT_PRIVATE_KEY");
  if (key !== undefined && nw !== "testnet") bad.push("AGENT_PRIVATE_KEY is only allowed when NEAR_NETWORK=testnet (production keys come from the Shade Agent API)");

  const tierEnabled = { 1: true, 2: true, 3: true };
  for (const t of [1, 2, 3] as const) {
    const v = get(`TIER_ENABLED_${t}`);
    if (v !== undefined && v !== "0" && v !== "1") bad.push(`TIER_ENABLED_${t} must be 0 or 1, got "${v}"`);
    tierEnabled[t] = v !== "0";
  }

  const c: Config = {
    network,
    mock,
    nearRpc: need("NEAR_RPC", live),
    vaultAccount: need("VAULT_ACCOUNT", live),
    agentAccount: need("AGENT_ACCOUNT", live),
    agentPrivateKey: key,
    nearaiBase: get("NEARAI_BASE") ?? cfg.nearai_base,
    nearaiApiKey: need("NEARAI_API_KEY", live),
    models: { 1: get("TIER_MODEL_1") ?? cfg.tier_model, 2: get("TIER_MODEL_2") ?? cfg.tier_model, 3: get("TIER_MODEL_3") ?? cfg.tier_model },
    judgeModel: get("JUDGE_MODEL") ?? cfg.judge_model,
    convexUrl: get("CONVEX_URL"),
    convexSiteUrl: need("CONVEX_SITE_URL"),
    agentSecret: secret("AGENT_SECRET"),
    pepper: secret("PEPPER"),
    sessionSecret: secret("SESSION_SECRET"),
    proxySecret: secret("PROXY_SECRET"),
    mempoolBase: need("MEMPOOL_BASE", live),
    baseRpc: need("BASE_RPC", live && tierEnabled[2]),
    tierEnabled,
    // No "local" fallback where a real measurement is expected: a production agent that cannot say what it runs does not start.
    codehash: dev ? (get("CODEHASH") ?? "local") : need("CODEHASH"),
    firewallVersion: dev ? (get("FIREWALL_VERSION") ?? "fw-v1") : need("FIREWALL_VERSION"),
    siteUrl: (dev ? get("SITE_URL") ?? "" : need("SITE_URL")).replace(/\/+$/, ""),
    alertWebhookUrl: get("ALERT_WEBHOOK_URL"),
    rateLimitScale: scale,
    dailyUsd,
    llmTimeoutMs: posInt("LLM_TIMEOUT_MS", 20_000),
    judgeTimeoutMs: posInt("JUDGE_TIMEOUT_MS", 3_500),
    port: posInt("PORT", 8787),
    btcHrp: network === "mainnet" ? "bc" : "tb",
  };
  url("NEARAI_BASE", c.nearaiBase, true);
  url("NEAR_RPC", c.nearRpc, false);
  url("MEMPOOL_BASE", c.mempoolBase, true);
  url("BASE_RPC", c.baseRpc, false);
  url("SITE_URL", c.siteUrl, false);
  url("ALERT_WEBHOOK_URL", c.alertWebhookUrl ?? "", true);
  if (bad.length) throw new ConfigError(bad);
  return c;
}
