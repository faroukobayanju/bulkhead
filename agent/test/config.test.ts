import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConfigError, ENV_DOC, envExample, loadConfig } from "../src/config";

const S = (c: string) => c.repeat(32);
const mock = { NEAR_NETWORK: "testnet", MOCK_LLM: "1", CONVEX_SITE_URL: "https://x.convex.site", AGENT_SECRET: S("a"), PEPPER: S("b"), SESSION_SECRET: S("c"), PROXY_SECRET: S("d") };
const testnet = { ...mock, MOCK_LLM: undefined, CODEHASH: "cd".repeat(32), NEAR_RPC: "https://rpc.testnet.near.org", VAULT_ACCOUNT: "v.testnet", AGENT_ACCOUNT: "a.testnet", NEARAI_API_KEY: "k", MEMPOOL_BASE: "https://mempool.space/testnet4/api", BASE_RPC: "https://sepolia.base.org" };
const main = { ...testnet, NEAR_NETWORK: "mainnet", CODEHASH: "ab".repeat(32), FIREWALL_VERSION: "fw-v1", SITE_URL: "https://bulkhead.example", MEMPOOL_BASE: "https://mempool.space/api" };
const problems = (env: object) => {
  try {
    loadConfig(env as Record<string, string>);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems.join("\n");
  }
  return "";
};

describe("config", () => {
  test("mock mode needs only the Convex, secret and network vars", () => {
    const c = loadConfig(mock);
    expect(c).toMatchObject({ mock: true, network: "testnet", codehash: "local", btcHrp: "tb", port: 8787, llmTimeoutMs: 20000, judgeTimeoutMs: 3500 });
    expect(c.models[1]).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });
  test("the general-mode firewall version defaults to fw-general-v1 and can be set", () => {
    expect(loadConfig(mock).firewallGeneralVersion).toBe("fw-general-v1");
    expect(loadConfig(main).firewallGeneralVersion).toBe("fw-general-v1");
    expect(loadConfig({ ...main, FIREWALL_GENERAL_VERSION: "fw-general-v2" }).firewallGeneralVersion).toBe("fw-general-v2");
  });
  test("a full testnet and a full mainnet config load", () => {
    expect(loadConfig(testnet).mock).toBe(false);
    expect(loadConfig(main)).toMatchObject({ btcHrp: "bc", codehash: "ab".repeat(32) });
  });
  test("every missing var is listed in one error", () => {
    const p = problems({ NEAR_NETWORK: "testnet" });
    for (const k of ["NEAR_RPC", "VAULT_ACCOUNT", "AGENT_ACCOUNT", "NEARAI_API_KEY", "CONVEX_SITE_URL", "AGENT_SECRET", "PEPPER", "SESSION_SECRET", "PROXY_SECRET", "MEMPOOL_BASE", "BASE_RPC"]) expect(p).toContain(k);
    expect(problems({ ...testnet, TIER_ENABLED_2: "0", BASE_RPC: undefined })).toBe("");
  });
  test("secrets under 32 bytes are refused", () => {
    for (const k of ["PEPPER", "SESSION_SECRET", "PROXY_SECRET", "AGENT_SECRET"]) expect(problems({ ...mock, [k]: "short" })).toContain(`${k} must be at least 32 bytes`);
  });
  test("there is no local codehash in production", () => {
    expect(problems({ ...main, CODEHASH: undefined })).toContain("CODEHASH is required");
    expect(problems({ ...testnet, CODEHASH: undefined })).toContain("CODEHASH is required"); // testnet too: only mock may say local
    expect(problems({ ...main, FIREWALL_VERSION: undefined })).toContain("FIREWALL_VERSION is required");
    expect(problems({ ...main, SITE_URL: undefined })).toContain("SITE_URL is required");
  });
  test("CONVEX_SITE_URL must be https; http only for localhost on testnet", () => {
    expect(problems({ ...mock, CONVEX_SITE_URL: "http://x.convex.site" })).toContain("CONVEX_SITE_URL must be an https URL");
    expect(problems({ ...mock, CONVEX_SITE_URL: "not a url" })).toContain("CONVEX_SITE_URL must be a URL");
    expect(problems({ ...mock, CONVEX_SITE_URL: "ftp://x" })).toContain("CONVEX_SITE_URL must be an https URL");
    expect(problems({ ...mock, CONVEX_SITE_URL: "http://localhost:3211" })).toBe("");
    expect(problems({ ...mock, CONVEX_SITE_URL: "http://127.0.0.1:3211" })).toBe("");
    expect(problems({ ...main, CONVEX_SITE_URL: "http://localhost:3211" })).toContain("CONVEX_SITE_URL must be an https URL");
    expect(problems({ ...main, CONVEX_SITE_URL: "http://localhost.evil.com" })).toContain("CONVEX_SITE_URL");
  });
  test("NEARAI_BASE cannot be overridden on mainnet", () => {
    expect(problems({ ...main, NEARAI_BASE: "https://evil.example/v1" })).toContain("NEARAI_BASE may not be overridden on mainnet");
    expect(problems({ ...main, NEARAI_BASE: "https://cloud-api.near.ai/v1" })).toBe("");
    expect(problems({ ...testnet, NEARAI_BASE: "https://staging.example/v1" })).toBe("");
  });
  test("mock mode and the agent key are testnet only", () => {
    expect(problems({ ...main, MOCK_LLM: "1" })).toContain("MOCK_LLM is only allowed when NEAR_NETWORK=testnet");
    expect(problems({ ...main, AGENT_PRIVATE_KEY: "ed25519:x" })).toContain("AGENT_PRIVATE_KEY is only allowed");
    expect(problems({ ...mock, MOCK_LLM: "yes" })).toContain("MOCK_LLM must be 0 or 1");
  });
  test("a bad RATE_LIMIT_SCALE stops startup (E22)", () => {
    expect(problems({ ...mock, RATE_LIMIT_SCALE: "0" })).toContain("RATE_LIMIT_SCALE");
    expect(problems({ ...main, RATE_LIMIT_SCALE: "0.1" })).toContain("only allowed when NEAR_NETWORK=testnet");
    expect(loadConfig({ ...mock, RATE_LIMIT_SCALE: "0.01" }).rateLimitScale).toBe(0.01);
  });
  test("numbers, flags and URLs are validated", () => {
    expect(problems({ ...mock, LLM_TIMEOUT_MS: "0" })).toContain("LLM_TIMEOUT_MS");
    expect(problems({ ...mock, JUDGE_TIMEOUT_MS: "fast" })).toContain("JUDGE_TIMEOUT_MS");
    expect(problems({ ...mock, TIER_ENABLED_3: "2" })).toContain("TIER_ENABLED_3");
    expect(problems({ ...mock, NEARAI_DAILY_USD: "-1" })).toContain("NEARAI_DAILY_USD");
    expect(problems({ ...mock, ALERT_WEBHOOK_URL: "http://hooks.example" })).toContain("ALERT_WEBHOOK_URL must be an https URL");
    expect(problems({ ...testnet, MEMPOOL_BASE: "http://mempool.example" })).toContain("MEMPOOL_BASE must be an https URL");
    expect(problems({ ...mock, NEAR_NETWORK: "devnet" })).toContain("NEAR_NETWORK");
  });
  test(".env.example is generated from the table: one comment per var, no values", () => {
    const file = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    expect(file).toBe(envExample());
    const lines = file.split("\n").filter(Boolean);
    expect(lines.filter(l => l.startsWith("#")).length).toBe(ENV_DOC.length);
    for (const l of lines.filter(l => !l.startsWith("#"))) expect(l).toMatch(/^[A-Z0-9_]+=$/);
  });
});
