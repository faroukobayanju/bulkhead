import { describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { memoryCounter } from "../src/counter";
import { rebroadcastOnce, startRebroadcast, type Payout, type RebroadcastDeps } from "../src/chain/rebroadcast";
import { makeChainDeps } from "../src/chain/vault";
import type { Config } from "../src/config";
import type { ChainDeps } from "../src/server";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const row = (o: Partial<Payout> = {}): Payout => ({ id: "01JB0000000000000000000001", tier: 1, outcome: "signed_pending_broadcast", ts: new Date(NOW - 60_000).toISOString(), near_tx: "nt", ...o });

function rig(rows: Payout[], o: Partial<RebroadcastDeps> = {}) {
  const log = { updates: [] as [string, any][], alerts: [] as [string, any][], settled: [] as number[], broadcasts: [] as string[] };
  const d: RebroadcastDeps = {
    payouts: async () => rows,
    signedTx: async () => ({ chain: "btc", hex: "0200ff" }),
    pendingTx: async () => null,
    broadcast: async (_c, hex) => (log.broadcasts.push(hex), "txid1"),
    update: async (id, p) => void log.updates.push([id, p]),
    failures: memoryCounter(),
    alert: (k, x) => void log.alerts.push([k, x]),
    onSettled: t => void log.settled.push(t),
    clock: () => NOW,
    ...o,
  };
  return { d, log };
}

describe("rebroadcastOnce", () => {
  test("a signed payout is broadcast, becomes drained with its txid, and frees the tier lock", async () => {
    const { d, log } = rig([row({ tier: 3 })]);
    expect(await rebroadcastOnce(d)).toEqual({ settled: 1, failed: 0, terminal: 0, reconciled: 0 });
    expect(log.broadcasts).toEqual(["0200ff"]);
    expect(log.updates).toEqual([[row().id, { outcome: "drained", chain_txid: "txid1" }]]);
    expect(log.settled).toEqual([3]);
  });
  test("an EVM payout goes to the evm broadcaster", async () => {
    const chains: string[] = [];
    const { d } = rig([row({ tier: 2 })], { signedTx: async () => ({ chain: "evm", hex: "0x02" }), broadcast: async c => (chains.push(c), "0xhash") });
    await rebroadcastOnce(d);
    expect(chains).toEqual(["evm"]);
  });
  test("a failed broadcast changes nothing and is counted; the lock stays", async () => {
    const { d, log } = rig([row()], { broadcast: async () => { throw new Error("mempool down"); } });
    expect(await rebroadcastOnce(d)).toMatchObject({ failed: 1, settled: 0, terminal: 0 });
    expect(log.updates).toEqual([]);
    expect(log.settled).toEqual([]);
    expect(await d.failures.get(`rebroadcast:${row().id}`)).toBe(1);
  });
  test("the tenth failure marks broadcast_failed_terminal and alerts; the ninth does not", async () => {
    const { d, log } = rig([row()], { broadcast: async () => { throw new Error("rejected"); } });
    for (let i = 0; i < 9; i++) await rebroadcastOnce(d);
    expect(log.updates).toEqual([]);
    expect(log.alerts).toEqual([]);
    expect(await rebroadcastOnce(d)).toMatchObject({ terminal: 1 });
    expect(log.updates).toEqual([[row().id, { outcome: "broadcast_failed_terminal" }]]);
    expect(log.alerts[0]![0]).toBe("broadcast_failed_terminal");
    expect(log.alerts[0]![1]).toMatchObject({ attempt_id: row().id, near_tx: "nt", attempts: 10 });
    expect(log.settled).toEqual([]); // paid on-chain, never freed
  });
  test("no stored signed tx counts as a failure", async () => {
    const { d } = rig([row()], { signedTx: async () => null });
    expect(await rebroadcastOnce(d)).toMatchObject({ failed: 1 });
  });
  test("an update that fails after the broadcast is not a broadcast failure", async () => {
    const warns: string[] = [];
    const { d } = rig([row()], { update: async () => { throw new Error("db down"); }, warn: w => void warns.push(w) });
    expect(await rebroadcastOnce(d)).toMatchObject({ failed: 0, settled: 0 });
    expect(await d.failures.get(`rebroadcast:${row().id}`)).toBe(0);
    expect(warns).toEqual(["rebroadcast_row_failed"]);
  });
  test("one bad row does not stop the others", async () => {
    const { d, log } = rig([row({ id: "01JB0000000000000000000002" }), row()], { signedTx: async id => { if (id.endsWith("2")) throw new Error("x"); return { chain: "btc", hex: "aa" }; } });
    const r = await rebroadcastOnce(d);
    expect(r.settled).toBe(1);
    expect(r.failed).toBe(1);
    expect(log.updates).toHaveLength(1);
  });

  describe("stale releasing rows", () => {
    const old = (o: Partial<Payout> = {}) => row({ outcome: "releasing", ts: new Date(NOW - 16 * 60_000).toISOString(), ...o });
    test("older than 15 minutes with no pending_tx: release_failed, alert, lock freed", async () => {
      const { d, log } = rig([old({ tier: 2 })]);
      expect(await rebroadcastOnce(d)).toMatchObject({ reconciled: 1 });
      expect(log.updates).toEqual([[row().id, { outcome: "release_failed" }]]);
      expect(log.alerts[0]![0]).toBe("release_failed");
      expect(log.settled).toEqual([2]);
      expect(log.broadcasts).toEqual([]);
    });
    test("younger than 15 minutes is left alone", async () => {
      const { d, log } = rig([old({ ts: new Date(NOW - 14 * 60_000).toISOString() })]);
      await rebroadcastOnce(d);
      expect(log.updates).toEqual([]);
    });
    test("with a pending_tx the contract did sign: it becomes signed_pending_broadcast and is rebroadcast", async () => {
      const { d, log } = rig([old()], { pendingTx: async () => "0200" });
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1, reconciled: 0 });
      expect(log.updates.map(u => u[1].outcome)).toEqual(["signed_pending_broadcast", "drained"]);
    });
    test("a pending_tx check that fails changes nothing", async () => {
      const { d, log } = rig([old()], { pendingTx: async () => { throw new Error("rpc down"); } });
      await rebroadcastOnce(d);
      expect(log.updates).toEqual([]);
    });
  });
});

describe("startRebroadcast", () => {
  test("runs on an interval, never overlaps, and stops", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const { d } = rig([], { payouts: async () => (calls++, gate.then(() => [])) });
    const stop = startRebroadcast({ ...d, intervalMs: 5 });
    await Bun.sleep(40);
    expect(calls).toBe(1); // the first run is still going
    release();
    await Bun.sleep(40);
    expect(calls).toBeGreaterThan(1);
    stop();
    const n = calls;
    await Bun.sleep(30);
    expect(calls).toBe(n);
  });
  test("a failing run is reported and the loop keeps going", async () => {
    const seen: string[] = [];
    const { d } = rig([], { payouts: async () => { throw new Error("db down"); }, warn: w => void seen.push(w) });
    const stop = startRebroadcast({ ...d, intervalMs: 5 });
    await Bun.sleep(30);
    stop();
    expect(seen.length).toBeGreaterThan(1);
  });
});

describe("makeChainDeps", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const cfg = { network: "testnet", nearRpc: "https://rpc.test", vaultAccount: "v.testnet", agentAccount: "a.testnet", agentPrivateKey: kp.toString(), mempoolBase: "https://m.test/api", baseRpc: "", btcHrp: "tb" } as unknown as Config;
  const db = { putSignedTx: async () => true, getSignedTx: async () => null, updateAttempt: async () => {}, listAttempts: async () => ({ rows: [], next: "", done: true }), counter: memoryCounter() };

  test("fits the ChainDeps of server.ts (all but viewAccessKey)", () => {
    const chain: Omit<ChainDeps, "viewAccessKey"> = makeChainDeps(cfg, { db, onSettled: () => {} });
    expect(Object.keys(chain)).toEqual(expect.arrayContaining(["release", "tierOpen", "wasSigned", "storeSignedTx", "startRebroadcast"]));
  });
  test("needs a signing key", () => {
    expect(() => makeChainDeps({ ...cfg, agentPrivateKey: undefined }, { db, onSettled: () => {} })).toThrow("signing key");
  });
  test("storeSignedTx writes the row", async () => {
    const got: any[] = [];
    const chain = makeChainDeps(cfg, { db: { ...db, putSignedTx: async r => (got.push(r), true) }, onSettled: () => {} });
    await chain.storeSignedTx("id1", "btc", "0200");
    expect(got).toEqual([{ attempt_id: "id1", chain: "btc", hex: "0200" }]);
  });
  test("the loop pages the attempt export and picks releasing and signed_pending_broadcast rows only", async () => {
    const pages = [
      { rows: [{ id: "a", tier: 1, outcome: "refused", ts: "t" }, { id: "b", tier: 1, outcome: "signed_pending_broadcast", ts: "t", near_tx: "n" }], next: "c1", done: false },
      { rows: [{ id: "c", tier: 3, outcome: "releasing", ts: "t", near_tx: null }, { id: "d", tier: 3, outcome: "drained", ts: "t" }], next: "", done: true },
    ];
    const cursors: (string | null)[] = [];
    const seen: string[] = [];
    const chain = makeChainDeps(cfg, { db: { ...db, listAttempts: async (_s, c) => (cursors.push(c), pages[cursors.length - 1]!), getSignedTx: async id => (seen.push(id), null) }, onSettled: () => {}, fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    const stop = chain.startRebroadcast({ alert: () => {}, intervalMs: 5 });
    await Bun.sleep(40);
    stop();
    expect(cursors.slice(0, 2)).toEqual([null, "c1"]);
    expect(seen).toContain("b"); // only the signed one reaches the signed-tx lookup; "c" is releasing and its pending_tx call fails
    expect(seen).not.toContain("a");
    expect(seen).not.toContain("d");
  });
});
