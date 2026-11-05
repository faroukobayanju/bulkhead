import { describe, expect, test } from "bun:test";
import { main, type DemoVault } from "../../scripts/attack-demo";
import { ContractRefusedError, SignFailedError } from "../src/chain/vault";
import { BroadcastFailedError } from "../src/pipeline";

const lines = () => {
  const out: string[] = [];
  return { out, log: (s: string) => void out.push(s), text: () => out.join("\n") };
};
const RECIPIENT = "tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er";
const ENV = { DEMO_RECIPIENT: RECIPIENT };

// A vault that behaves like the contract: a cap on the payload amount, and a 60 s cooldown after each payout.
type Fake = { chain?: "Bitcoin" | "Base"; cap?: boolean; cooldownS?: number; roundsLeft?: number; broadcastFails?: boolean; payout?: "refused" | "sign_failed"; noCooldown?: boolean };
function fakeVault(o: Fake = {}) {
  const sent: string[] = [];
  const payloads: any[] = [];
  const tier = { id: 1, chain: o.chain ?? "Bitcoin", max_release: "2000000", cooldown_s: o.cooldownS ?? 60, rounds_left: o.roundsLeft ?? 5, status: "Open", cooldown_until_ns: 0 };
  const cooling = () => tier.cooldown_until_ns > Date.now() * 1e6;
  const pay = () => {
    if (cooling()) throw new ContractRefusedError("ERR_COOLDOWN");
    if (!o.noCooldown) tier.cooldown_until_ns = (Date.now() + 60_000) * 1e6;
  };
  const amountOf = (p: any) => BigInt(p.Bitcoin?.utxos[0].value_sat ?? p.Base.usdc_amount);
  const v = {
    getTier: async () => ({ ...tier }),
    releaseWith: async (_t: number, _id: string, _to: string, p: any) => {
      sent.push(`raw ${amountOf(p)}`);
      payloads.push(p);
      if (cooling()) throw new ContractRefusedError("ERR_COOLDOWN");
      if (o.cap !== false && amountOf(p) > 2_000_000n) throw new ContractRefusedError("ERR_OVER_CAP");
      pay();
      return "near-tx";
    },
    release: async () => {
      sent.push("release");
      if (o.payout === "refused") throw new ContractRefusedError("ERR_TIER_NOT_OPEN");
      if (o.payout === "sign_failed") throw new SignFailedError();
      pay();
      if (o.broadcastFails) throw new BroadcastFailedError("near-tx");
      return { nearTx: "near-tx", chainTxid: "btc-tx" };
    },
  } as unknown as DemoVault;
  return { v, sent, payloads };
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
    expect(t).toMatch(/mock judge \(MOCK_LLM fixture\)/);
    expect(t).toMatch(/1\. .*benign[\s\S]*mock judge \(fixture\): allow/i);
    expect(t).toMatch(/2\. .*override[\s\S]*mock judge \(fixture\): block[\s\S]*act never called/i);
    expect(t).toMatch(/3\. .*morse[\s\S]*mock judge \(fixture\): block, risk \d+, technique encoding/i);
    expect(t).toMatch(/4\. [\s\S]*needs --testnet[\s\S]*skipped/i);
    expect(t).toMatch(/3 of 3 .*as expected/i);
  });

  test("heuristics alone: 50 and escalate for both attacks (override, encoding), allow for the benign message", async () => {
    const l = lines();
    await main(["--local"], {}, { log: l.log });
    const h = l.out.filter(s => s.includes("heuristics alone"));
    expect(h).toHaveLength(3);
    expect(h[0]).toMatch(/heuristics alone: 0, allow/);
    expect(h[1]).toMatch(/heuristics alone: 50, escalate, technique override; act not called/);
    expect(h[2]).toMatch(/heuristics alone: 50, escalate, technique encoding; act not called/);
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
  test("Bitcoin: over the cap ERR_OVER_CAP, within success, again ERR_COOLDOWN; made-up coins have a zero txid", async () => {
    const l = lines();
    const f = fakeVault();
    expect(await main(["--testnet"], ENV, { log: l.log, vault: f.v })).toBe(0);
    expect(f.sent).toEqual(["raw 2000001", "release", "raw 2000000"]);
    for (const p of f.payloads) expect(p.Bitcoin.utxos[0].txid).toBe("00".repeat(32));
    expect(l.text()).toMatch(/4 of 4 .*as expected/i);
  });

  test("Base: same results, and made-up payloads carry a nonce no account reaches", async () => {
    const f = fakeVault({ chain: "Base" });
    expect(await main(["--testnet"], ENV, { log: () => {}, vault: f.v })).toBe(0);
    expect(f.sent).toEqual(["raw 2000001", "release", "raw 2000000"]);
    for (const p of f.payloads) expect(p.Base.nonce).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("a payout that signed but failed to broadcast still counts as the contract paying", async () => {
    const f = fakeVault({ broadcastFails: true });
    expect(await main(["--testnet"], ENV, { log: () => {}, vault: f.v })).toBe(0);
  });

  test("the payout does not succeed: the repeat is never sent", async () => {
    for (const payout of ["refused", "sign_failed"] as const) {
      const l = lines();
      const f = fakeVault({ payout });
      expect(await main(["--testnet"], ENV, { log: l.log, vault: f.v })).toBe(1);
      expect(f.sent).toEqual(["raw 2000001", "release"]);
      expect(l.text()).toMatch(/stopping/);
    }
  });

  test("no cooldown showing after the payout: the repeat is never sent", async () => {
    const l = lines();
    const f = fakeVault({ noCooldown: true });
    expect(await main(["--testnet"], ENV, { log: l.log, vault: f.v })).toBe(1);
    expect(f.sent).toEqual(["raw 2000001", "release"]);
    expect(l.text()).toMatch(/repeat not sent/);
  });

  test("a contract without a cap stops at the first call", async () => {
    const l = lines();
    const f = fakeVault({ cap: false });
    expect(await main(["--testnet"], ENV, { log: l.log, vault: f.v })).toBe(1);
    expect(f.sent).toEqual(["raw 2000001"]);
    expect(l.text()).toMatch(/FAIL: expected ERR_OVER_CAP/);
  });

  test("a tier with a short cooldown or one round left sends nothing", async () => {
    for (const o of [{ cooldownS: 5 }, { roundsLeft: 1 }]) {
      const f = fakeVault(o);
      expect(await main(["--testnet"], ENV, { log: () => {}, vault: f.v })).toBe(1);
      expect(f.sent).toEqual([]);
    }
  });
});

describe("attack demo --testnet config, checked before anything is sent", () => {
  const TESTNET = {
    NEAR_NETWORK: "testnet", NEAR_RPC: "https://rpc.test", VAULT_ACCOUNT: "vault.me.testnet", AGENT_ACCOUNT: "agent.me.testnet",
    AGENT_PRIVATE_KEY: "ed25519:x", MEMPOOL_BASE: "https://mempool.test", DEMO_RECIPIENT: RECIPIENT,
  };
  const rpc = (chainId: string) => {
    const calls: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string).method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "demo", result: { chain_id: chainId } }));
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  test("without the vault env it refuses", async () => {
    const l = lines();
    expect(await main(["--testnet"], { NEAR_NETWORK: "testnet" }, { log: l.log })).toBe(2);
    expect(l.text()).toMatch(/NEAR_RPC/);
    expect(l.text()).not.toMatch(/^1\./m);
  });

  test("refuses anything but the testnet label", async () => {
    const l = lines();
    expect(await main(["--testnet"], { ...TESTNET, NEAR_NETWORK: "mainnet" }, { log: l.log })).toBe(2);
    expect(l.text()).toMatch(/testnet/);
  });

  test("testnet label with a mainnet account: refused, no RPC call", async () => {
    for (const k of ["VAULT_ACCOUNT", "AGENT_ACCOUNT"]) {
      const l = lines();
      const r = rpc("testnet");
      expect(await main(["--testnet"], { ...TESTNET, [k]: "vault.bulkhead.near" }, { log: l.log, fetch: r.f })).toBe(2);
      expect(l.text()).toContain(`${k} must be a .testnet account`);
      expect(r.calls).toEqual([]);
    }
  });

  test("an RPC that reports mainnet: refused after one status call", async () => {
    const l = lines();
    const r = rpc("mainnet");
    expect(await main(["--testnet"], TESTNET, { log: l.log, fetch: r.f })).toBe(2);
    expect(r.calls).toEqual(["status"]);
    expect(l.text()).toMatch(/chain_id "mainnet"/);
  });
});
