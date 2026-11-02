import { describe, expect, test } from "bun:test";
import { main as smoke } from "../../scripts/tier-smoke";

// scripts/tier-smoke.ts makes real, billed NEAR AI calls, so only its refusal path is tested here. The controller runs it live.
const KEY = "sk-test-SECRET-tier-smoke-key";
const noNetwork = () => {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(String(url));
    throw new Error("no network in tests");
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};
const lines = () => {
  const out: string[] = [];
  return { out, log: (s: string) => void out.push(s), text: () => out.join("\n") };
};

describe("tier-smoke refuses to run", () => {
  const cases: [string, string[], Record<string, string>][] = [
    ["without LIVE", ["--max-usd", "1"], { NEARAI_API_KEY: KEY }],
    ["with LIVE=0", ["--max-usd", "1"], { LIVE: "0", NEARAI_API_KEY: KEY }],
    ["with LIVE=true", ["--max-usd", "1"], { LIVE: "true", NEARAI_API_KEY: KEY }],
    ["without --max-usd", [], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd and no value", ["--max-usd"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd abc", ["--max-usd", "abc"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd 0", ["--max-usd", "0"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd -1", ["--max-usd", "-1"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd NaN", ["--max-usd", "NaN"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["with --max-usd Infinity", ["--max-usd", "Infinity"], { LIVE: "1", NEARAI_API_KEY: KEY }],
    ["without NEARAI_API_KEY", ["--max-usd", "1"], { LIVE: "1" }],
    ["with an empty NEARAI_API_KEY", ["--max-usd", "1"], { LIVE: "1", NEARAI_API_KEY: "" }],
    ["with the key on the command line instead of the environment", ["--max-usd", "1", "--api-key", KEY], { LIVE: "1" }],
  ];
  test.each(cases)("%s: exits 2 without a network call and never prints the key", async (_, argv, env) => {
    const net = noNetwork();
    const l = lines();
    expect(await smoke(argv, env, { fetch: net.fetch, log: l.log })).toBe(2);
    expect(net.calls).toEqual([]);
    expect(l.out.length).toBeGreaterThan(0);
    expect(l.text()).not.toContain(KEY);
  });

  test("the message says what to set", async () => {
    const l = lines();
    await smoke([], {}, { fetch: noNetwork().fetch, log: l.log });
    expect(l.text()).toContain("LIVE=1");
    await smoke([], { LIVE: "1" }, { fetch: noNetwork().fetch, log: l.log });
    expect(l.text()).toContain("--max-usd");
    await smoke(["--max-usd", "1"], { LIVE: "1" }, { fetch: noNetwork().fetch, log: l.log });
    expect(l.text()).toContain("NEARAI_API_KEY");
  });
});
