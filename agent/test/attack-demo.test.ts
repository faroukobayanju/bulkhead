import { describe, expect, test } from "bun:test";
import { main, type DemoVault } from "../../scripts/attack-demo";
import { ContractRefusedError } from "../src/chain/vault";
import { BroadcastFailedError } from "../src/pipeline";

const lines = () => {
  const out: string[] = [];
  return { out, log: (s: string) => void out.push(s), text: () => out.join("\n") };
};
const RECIPIENT = "tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er";
const ENV = { DEMO_RECIPIENT: RECIPIENT };

// A vault that behaves like the contract: a cap on the payload amount, and a cooldown after each payout.
function fakeVault(o: { cap?: boolean; cooldownS?: number; roundsLeft?: number; broadcastFails?: boolean } = {}) {
  const sent: string[] = [];
  let cooling = false;
  const amountOf = (p: any) => BigInt(p.Bitcoin?.utxos[0].value_sat ?? p.Base.usdc_amount);
  const tier = { id: 1, chain: "Bitcoin", max_release: "2000000", cooldown_s: o.cooldownS ?? 60, rounds_left: o.roundsLeft ?? 5, status: "Open" };
  const pay = () => {
    if (cooling) throw new ContractRefusedError("ERR_COOLDOWN");
    cooling = true;
  };
  const v = {
    getTier: async () => tier,
    releaseWith: async (_t: number, _id: string, _to: string, p: any) => {
      sent.push(`raw ${amountOf(p)}`);
      if (cooling) throw new ContractRefusedError("ERR_COOLDOWN");
      if (o.cap !== false && amountOf(p) > 2_000_000n) throw new ContractRefusedError("ERR_OVER_CAP");
      pay();
      return "near-tx";
    },
    release: async () => {
      sent.push("release");
      pay();
      if (o.broadcastFails) throw new BroadcastFailedError("near-tx");
      return { nearTx: "near-tx", chainTxid: "btc-tx" };
    },
  } as unknown as DemoVault;
  return { v, sent };
}

describe("attack demo --local", () => {
  test("runs steps 1-3 offline with the mock judge, skips step 4, exits 0", async () => {
    const l = lines();
    const fetchBefore = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => (fetched++, new Response("{}"))) as unknown as typeof fetch;
    try {
      expect(await main(["--local"], {}, { log: l.log })).toBe(0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
    expect(fetched).toBe(0);
    const t = l.text();
    expect(t).toMatch(/mock model/i);
    expect(t).toMatch(/1\. .*benign.*\n.*allow/i);
    expect(t).toMatch(/2\. .*override[\s\S]*block[\s\S]*act never called/i);
    expect(t).toMatch(/3\. .*morse[\s\S]*block[\s\S]*encoding/i);
    expect(t).toMatch(/4\. [\s\S]*needs --testnet[\s\S]*skipped/i);
    expect(t).toMatch(/3 of 3 .*as expected/i);
  });

  test("a step that differs makes it exit 1 and says which", async () => {
    const l = lines();
    // a judge talked into a zero: heuristics alone escalate the override, they never block it
    const fooled = async () => ({ risk: 0, technique: "none" as const, reason: "safe" });
    expect(await main(["--local"], {}, { log: l.log, judge: fooled })).toBe(1);
    expect(l.text()).toMatch(/2\. [\s\S]*FAIL[\s\S]*expected block/);
  });

  test("needs exactly one of --local or --testnet", async () => {
    for (const argv of [[], ["--local", "--testnet"], ["--live"]]) {
      const l = lines();
      expect(await main(argv, {}, { log: l.log })).toBe(2);
      expect(l.text()).toMatch(/usage/i);
    }
  });
});

describe("attack demo step 4 (--testnet) against a fake vault", () => {
  test("over the cap: ERR_OVER_CAP; within: success; again: ERR_COOLDOWN; exits 0", async () => {
    const l = lines();
    const f = fakeVault();
    expect(await main(["--testnet"], ENV, { log: l.log, vault: f.v })).toBe(0);
    expect(f.sent).toEqual(["raw 2000001", "release", "raw 2000000"]);
    const t = l.text();
    expect(t).toMatch(/ERR_OVER_CAP/);
    expect(t).toMatch(/ERR_COOLDOWN/);
    expect(t).toMatch(/4 of 4 .*as expected/i);
  });

  test("a payout that signed but failed to broadcast still counts as the contract paying", async () => {
    const f = fakeVault({ broadcastFails: true });
    expect(await main(["--testnet"], ENV, { log: () => {}, vault: f.v })).toBe(0);
  });

  test("a contract without a cap fails step 4", async () => {
    const l = lines();
    expect(await main(["--testnet"], ENV, { log: l.log, vault: fakeVault({ cap: false }).v })).toBe(1);
    expect(l.text()).toMatch(/FAIL[\s\S]*expected ERR_OVER_CAP/);
  });

  test("a tier with a short cooldown or one round left sends nothing", async () => {
    for (const o of [{ cooldownS: 5 }, { roundsLeft: 1 }]) {
      const l = lines();
      const f = fakeVault(o);
      expect(await main(["--testnet"], ENV, { log: l.log, vault: f.v })).toBe(1);
      expect(f.sent).toEqual([]);
    }
  });

  test("without the vault env it refuses before sending anything", async () => {
    const l = lines();
    expect(await main(["--testnet"], { NEAR_NETWORK: "testnet" }, { log: l.log })).toBe(2);
    expect(l.text()).toMatch(/NEAR_RPC/);
    expect(l.text()).not.toMatch(/^1\./m); // refused before any step
  });

  test("refuses anything but testnet", async () => {
    const l = lines();
    const env = { NEAR_NETWORK: "mainnet", NEAR_RPC: "https://rpc", VAULT_ACCOUNT: "v", AGENT_ACCOUNT: "a", AGENT_PRIVATE_KEY: "k", MEMPOOL_BASE: "https://m", DEMO_RECIPIENT: RECIPIENT };
    expect(await main(["--testnet"], env, { log: l.log })).toBe(2);
    expect(l.text()).toMatch(/testnet/);
  });
});
