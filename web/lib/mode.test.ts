import { expect, test } from "bun:test";
import { checkMode } from "./mode";

test("MOCK_AGENT=1 runs locally and on preview deployments", () => {
  expect(checkMode({ MOCK_AGENT: "1" })).toBe(true);
  expect(checkMode({ MOCK_AGENT: "1", VERCEL_ENV: "preview", NEXT_PUBLIC_NETWORK: "testnet" })).toBe(true);
  expect(checkMode({})).toBe(false);
});

test("MOCK_AGENT=1 refuses to start in Vercel production or on mainnet", () => {
  expect(() => checkMode({ MOCK_AGENT: "1", VERCEL_ENV: "production" })).toThrow(/MOCK_AGENT/);
  expect(() => checkMode({ MOCK_AGENT: "1", NEXT_PUBLIC_NETWORK: "mainnet" })).toThrow(/MOCK_AGENT/);
});

test("without MOCK_AGENT, production and mainnet start", () => {
  expect(checkMode({ VERCEL_ENV: "production", NEXT_PUBLIC_NETWORK: "mainnet" })).toBe(false);
});
