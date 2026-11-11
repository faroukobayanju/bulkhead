import { defineConfig, devices } from "@playwright/test";

// The whole site under MOCK_AGENT=1: fixtures for the agent, the vault and Convex, no wallet. PROXY_SECRET is set to a marker
// so a test can prove it never reaches the browser.
export const PROXY_SECRET = "e2e-proxy-secret-7c1f0a9b2d";
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: `bun run build && bun run start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/rules`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { MOCK_AGENT: "1", PROXY_SECRET, AGENT_URL: "http://127.0.0.1:9", NEXT_PUBLIC_NETWORK: "testnet", TIER_ENABLED_1: "1", TIER_ENABLED_2: "1", TIER_ENABLED_3: "1", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
