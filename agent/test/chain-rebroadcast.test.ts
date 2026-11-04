import { describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { memoryCounter } from "../src/counter";
import { rebroadcastOnce, startRebroadcast, type Payout, type RebroadcastDeps, type Verdict } from "../src/chain/rebroadcast";
import { makeChainDeps } from "../src/chain/vault";
import type { Config } from "../src/config";
import type { ChainDeps } from "../src/server";

import { COPY } from "../src/pipeline";
import { TRANSITIONS } from "../../shared/attempt";
const COPY_FAILED = COPY.failed;
const NOW = Date.parse("2026-11-03T12:00:00Z");
const ID = "01JB0000000000000000000001";
const row = (o: Partial<Payout> = {}): Payout => ({ id: ID, tier: 1, outcome: "signed_pending_broadcast", ts: new Date(NOW - 60_000).toISOString(), near_tx: "nt", ...o });

// The store refuses what the real one refuses (shared/attempt.ts), and the work list shows each row as its current outcome.
function rig(rows: Payout[], o: Partial<RebroadcastDeps> = {}) {
  const state = new Map(rows.map(r => [r.id, r.outcome as string]));
  const log = { updates: [] as [string, any][], alerts: [] as [string, any][], settled: [] as [number, string][], broadcasts: [] as string[], stored: [] as any[], verdicts: [] as [string, number][] };
  const d: RebroadcastDeps = {
    payouts: async () => rows.filter(r => state.get(r.id) === "releasing" || state.get(r.id) === "signed_pending_broadcast").map(r => ({ ...r, outcome: state.get(r.id) as Payout["outcome"] })),
    signedTx: async () => ({ chain: "btc", hex: "0200ff" }),
    storeSignedTx: async (id, chain, hex) => void log.stored.push({ id, chain, hex }),
    recover: async () => null,
    pendingTx: async () => null,
    txVerdict: async (h, ref) => (log.verdicts.push([h, ref]), "failed" as Verdict),
    broadcast: async (_c, hex) => (log.broadcasts.push(hex), "txid1"),
    update: async (id, p) => {
      if (!TRANSITIONS[state.get(id)!]?.includes(p.outcome)) throw new Error(`bad_transition ${state.get(id)} to ${p.outcome}`);
      state.set(id, p.outcome);
      log.updates.push([id, p]);
    },
    failures: memoryCounter(),
    alert: (k, x) => void log.alerts.push([k, x]),
    onSettled: (t, id) => void log.settled.push([t, id]),
    clock: () => NOW,
    ...o,
  };
  return { d, log };
}

describe("rebroadcastOnce", () => {
  test("a signed payout is broadcast, becomes drained with its txid, and frees its own tier lock", async () => {
    const { d, log } = rig([row({ tier: 3 })]);
    expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1, failed: 0, terminal: 0, reconciled: 0 });
    expect(log.broadcasts).toEqual(["0200ff"]);
    expect(log.updates).toEqual([[ID, { outcome: "drained", chain_txid: "txid1", reply: COPY.paid }]]);
    expect(log.settled).toEqual([[3, ID]]);
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
    expect(await d.failures.get(`rebroadcast:${ID}`)).toBe(1);
  });
  test("the tenth failure marks broadcast_failed_terminal and alerts; the ninth does not", async () => {
    const { d, log } = rig([row()], { broadcast: async () => { throw new Error("rejected"); } });
    for (let i = 0; i < 9; i++) await rebroadcastOnce(d);
    expect(log.updates).toEqual([]);
    expect(log.alerts).toEqual([]);
    expect(await rebroadcastOnce(d)).toMatchObject({ terminal: 1 });
    expect(log.updates).toEqual([[ID, { outcome: "broadcast_failed_terminal" }]]);
    expect(log.alerts[0]![0]).toBe("broadcast_failed_terminal");
    expect(log.alerts[0]![1]).toMatchObject({ attempt_id: ID, near_tx: "nt", attempts: 10, error: "Error" }); // the class, never the message
    expect(JSON.stringify(log.alerts)).not.toContain("rejected");
    expect(log.settled).toEqual([[1, ID]]); // the lock goes at once, as it would after a restart; the coin stays excluded
  });
  test("no stored signed tx and no release tx hash: nothing was ever sent, so release_failed once pending_tx is None (no emergency-withdraw alert)", async () => {
    const { d, log } = rig([row()], { signedTx: async () => null });
    expect(await rebroadcastOnce(d)).toMatchObject({ reconciled: 1, failed: 0, terminal: 0 });
    expect(log.updates).toEqual([[ID, { outcome: "release_failed", reply: COPY_FAILED }]]);
    expect(log.alerts.map(a => a[0])).toEqual(["release_failed"]);
    expect(log.settled).toEqual([[1, ID]]);
  });
  test("no hash and no hex but the contract holds a pending_tx: counted as a failure, never closed", async () => {
    const { d, log } = rig([row()], { signedTx: async () => null, pendingTx: async () => "0200" });
    expect(await rebroadcastOnce(d)).toMatchObject({ failed: 1, reconciled: 0 });
    expect(log.updates).toEqual([]);
  });
  test("an update that fails after the broadcast is not a broadcast failure, and a row that moved on is only warned about", async () => {
    const warns: string[] = [];
    const { d } = rig([row()], { update: async () => { throw new Error("409 bad_transition release_failed to drained"); }, warn: w => void warns.push(w) });
    expect(await rebroadcastOnce(d)).toMatchObject({ failed: 0, settled: 0 });
    expect(await d.failures.get(`rebroadcast:${ID}`)).toBe(0);
    expect(warns).toEqual(["rebroadcast_row_failed"]);
  });
  test("one bad row does not stop the others", async () => {
    const { d, log } = rig([row({ id: "01JB0000000000000000000002" }), row()], { signedTx: async id => { if (id.endsWith("2")) throw new Error("x"); return { chain: "btc", hex: "aa" }; } });
    const r = await rebroadcastOnce(d);
    expect(r.settled).toBe(1);
    expect(r.failed).toBe(0); // a store read that throws is warned about, not a failed broadcast
    expect(log.updates).toHaveLength(1);
  });

  describe("signed hex missing: read back from the final NEAR release tx", () => {
    const lost = row({ release_tx: "H".repeat(44), release_ref_height: 500 });
    test("recovered, stored, then broadcast", async () => {
      const { d, log } = rig([lost], { signedTx: async () => null, recover: async p => (expect(p.release_tx).toBe("H".repeat(44)), { chain: "btc", hex: "beef" }) });
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1, failed: 0 });
      expect(log.stored).toEqual([{ id: ID, chain: "btc", hex: "beef" }]);
      expect(log.broadcasts).toEqual(["beef"]);
    });
    test("a failed store does not stop the broadcast", async () => {
      const { d, log } = rig([lost], { signedTx: async () => null, recover: async () => ({ chain: "btc", hex: "beef" }), storeSignedTx: async () => { throw new Error("db"); } });
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1 });
      expect(log.broadcasts).toEqual(["beef"]);
    });
    test("the NEAR tx not final yet, or unknown and not expired: waits, nothing is counted as failed, nothing is closed", async () => {
      for (const v of ["notfinal", "unknown"] as const) {
        const { d, log } = rig([lost], { signedTx: async () => null, recover: async () => null, txVerdict: async () => v });
        expect(await rebroadcastOnce(d)).toMatchObject({ waiting: 1, failed: 0, reconciled: 0 });
        expect(await d.failures.get(`rebroadcast:${ID}`)).toBe(0);
        expect(log.updates).toEqual([]);
        expect(log.alerts).toEqual([]);
      }
    });
    // B1: the release never signed (the signer failed after pending_tx showed), so the signed row closes instead of waiting forever
    for (const v of ["failed", "null", "expired"] as const) {
      test(`the release tx is ${v} and the contract has no pending_tx: release_failed, alert, lock freed`, async () => {
        const { d, log } = rig([lost], { signedTx: async () => null, recover: async () => null, txVerdict: async () => v });
        expect(await rebroadcastOnce(d)).toMatchObject({ reconciled: 1, failed: 0, waiting: 0 });
        expect(log.updates).toEqual([[ID, { outcome: "release_failed", reply: COPY_FAILED }]]);
        expect(log.alerts.map(a => a[0])).toEqual(["release_failed"]);
        expect(log.settled).toEqual([[1, ID]]);
        expect(log.broadcasts).toEqual([]);
      });
      test(`the release tx is ${v} but the contract still has a pending_tx: never closed, counted as a failure each tick (N2a)`, async () => {
        const { d, log } = rig([lost], { signedTx: async () => null, recover: async () => null, txVerdict: async () => v, pendingTx: async () => "0200" });
        expect(await rebroadcastOnce(d)).toMatchObject({ reconciled: 0, failed: 1 });
        expect(log.updates).toEqual([]);
        expect(log.settled).toEqual([]);
      });
    }
    test("a verdict that cannot be read changes nothing", async () => {
      const { d, log } = rig([lost], { signedTx: async () => null, recover: async () => null, txVerdict: async () => { throw new Error("rpc down"); } });
      await rebroadcastOnce(d);
      expect(log.updates).toEqual([]);
    });
    // N3: a node that cannot be reached is not a failed broadcast, however long it lasts
    test("RPC trouble in recover or the verdict is warned about and never counted, so it can never go terminal", async () => {
      const warns: string[] = [];
      for (const o of [{ recover: async () => { throw new Error("near rpc tx: http 502"); } }, { recover: async () => null, txVerdict: async () => { throw new Error("rpc down"); } }] as Partial<RebroadcastDeps>[]) {
        const { d, log } = rig([lost], { signedTx: async () => null, warn: w => void warns.push(w), ...o });
        for (let i = 0; i < 12; i++) await rebroadcastOnce(d);
        expect(await d.failures.get(`rebroadcast:${ID}`)).toBe(0);
        expect(log.updates).toEqual([]);
        expect(log.settled).toEqual([]);
      }
      expect(warns.length).toBe(24);
    });
    test("a signature that does not verify is a counted failure", async () => {
      const { d } = rig([lost], { signedTx: async () => null, recover: async () => { throw Object.assign(new Error("signature does not verify against the tier key"), { name: "SignatureError" }); } });
      expect(await rebroadcastOnce(d)).toMatchObject({ failed: 1 });
    });
    test("a stored hex is used as is, with no recovery", async () => {
      let calls = 0;
      const { d } = rig([lost], { recover: async () => (calls++, null) });
      await rebroadcastOnce(d);
      expect(calls).toBe(0);
    });
  });

  describe("terminal without a stored hex keeps the lock (N3)", () => {
    test("a signature that never verifies goes terminal, alerts, and does not free the tier", async () => {
      const { d, log } = rig([row({ release_tx: "H".repeat(44), release_ref_height: 500 })], { signedTx: async () => null, recover: async () => { throw Object.assign(new Error("bad sig"), { name: "SignatureError" }); } });
      for (let i = 0; i < 10; i++) await rebroadcastOnce(d);
      expect(log.updates).toEqual([[ID, { outcome: "broadcast_failed_terminal" }]]);
      expect(log.alerts[0]![1]).toMatchObject({ error: "SignatureError", fix: expect.stringContaining("owner action") });
      expect(log.settled).toEqual([]);
    });
  });

  describe("Base settles on the receipt, checked before any broadcast", () => {
    const evm = row({ tier: 2 });
    const mk = (status: "success" | "pending" | "reverted", o: Partial<RebroadcastDeps> = {}) => rig([evm], { signedTx: async () => ({ chain: "evm", hex: "0x02" }), receipt: async () => ({ status, txid: "0xhash" }), ...o });
    test("success: drained with the receipt's hash and the drained copy, freed, and never broadcast again", async () => {
      const { d, log } = mk("success");
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1, failed: 0 });
      expect(log.updates).toEqual([[ID, { outcome: "drained", chain_txid: "0xhash", reply: COPY.paid }]]);
      expect(log.settled).toEqual([[2, ID]]);
      expect(log.broadcasts).toEqual([]);
    });
    test("a mined tx whose broadcast would fail (nonce too low) is never counted toward terminal", async () => {
      const { d, log } = mk("success", { broadcast: async () => { throw new Error("nonce too low"); } });
      for (let i = 0; i < 3; i++) await rebroadcastOnce(d);
      expect(await d.failures.get(`rebroadcast:${ID}`)).toBe(0);
      expect(log.updates).toHaveLength(1);
    });
    test("pending: broadcast again, stays signed_pending_broadcast, lock kept, nothing counted", async () => {
      const { d, log } = mk("pending");
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 0, waiting: 1, failed: 0 });
      expect(log.broadcasts).toEqual(["0x02"]);
      expect(log.updates).toEqual([]);
      expect(log.settled).toEqual([]);
    });
    test("M1: pending after a successful broadcast for longer than staleMs: one base_tx_stalled alert (code only), lock kept, row untouched", async () => {
      const { d, log } = mk("pending", { clock: () => NOW + 20 * 60_000 }); // the row is 21 minutes old
      for (let i = 0; i < 3; i++) await rebroadcastOnce(d);
      expect(log.alerts.map(a => a[0])).toEqual(["base_tx_stalled"]);
      expect(log.alerts[0]![1]).toEqual({ attempt_id: ID, tier: 2 });
      expect(log.updates).toEqual([]);
      expect(log.settled).toEqual([]);
    });
    test("M1: a young pending row does not alert", async () => {
      const { d, log } = mk("pending");
      await rebroadcastOnce(d);
      expect(log.alerts).toEqual([]);
    });
    test("M1: settling a Base row to drained tells the operator; a Bitcoin row settled here does not (the pipeline path already alerts)", async () => {
      const a = mk("success");
      await rebroadcastOnce(a.d);
      expect(a.log.alerts).toEqual([["drained", { attempt_id: ID, tier: 2, chain_txid: "0xhash", near_tx: "nt" }]]);
      const b = rig([row()]);
      await rebroadcastOnce(b.d);
      expect(b.log.alerts).toEqual([]);
    });
    test("pending and the broadcast fails: a counted failure", async () => {
      const { d } = mk("pending", { broadcast: async () => { throw new Error("rejected"); } });
      expect(await rebroadcastOnce(d)).toMatchObject({ failed: 1 });
    });
    test("reverted: terminal, alert (class only), lock kept, no broadcast", async () => {
      const { d, log } = mk("reverted");
      expect(await rebroadcastOnce(d)).toMatchObject({ terminal: 1 });
      expect(log.updates).toEqual([[ID, { outcome: "broadcast_failed_terminal" }]]);
      expect(log.alerts.map(a => a[0])).toEqual(["broadcast_failed_terminal"]);
      expect(log.alerts[0]![1]).toMatchObject({ error: "reverted" });
      expect(log.settled).toEqual([]);
      expect(log.broadcasts).toEqual([]);
    });
    test("a receipt that cannot be read is warned about, not counted, not drained, not broadcast", async () => {
      const warns: string[] = [];
      const { d, log } = mk("success", { receipt: async () => { throw new Error("rpc"); }, warn: w => void warns.push(w) });
      await rebroadcastOnce(d);
      expect(warns).toEqual(["rebroadcast_row_failed"]);
      expect(log.updates).toEqual([]);
      expect(log.broadcasts).toEqual([]);
      expect(await d.failures.get(`rebroadcast:${ID}`)).toBe(0);
    });
    test("Bitcoin has no receipt step", async () => {
      const { d } = rig([row()], { receipt: async () => { throw new Error("must not be asked"); } });
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1 });
    });
  });

  describe("a recovered hex that cannot be stored (item 3)", () => {
    test("the lock is not freed at terminal until the hex is stored; the payout itself still broadcasts", async () => {
      const lost = row({ release_tx: "H".repeat(44), release_ref_height: 500 });
      const { d, log } = rig([lost], { signedTx: async () => null, recover: async () => ({ chain: "btc", hex: "beef" }), storeSignedTx: async () => { throw new Error("db"); }, broadcast: async () => { throw new Error("rejected"); } });
      for (let i = 0; i < 10; i++) await rebroadcastOnce(d);
      expect(log.updates).toEqual([[ID, { outcome: "broadcast_failed_terminal" }]]);
      expect(log.settled).toEqual([]);
      expect(log.alerts[0]![1]).toMatchObject({ fix: expect.stringContaining("owner action") });
    });
  });

  describe("stale releasing rows", () => {
    test("L5: a releasing row younger than 2 minutes is the live pipeline's: never promoted, even with a pending_tx and a signed verdict", async () => {
      const { d, log } = rig([row({ outcome: "releasing", ts: new Date(NOW - 60_000).toISOString(), release_tx: "H".repeat(44), release_ref_height: 9 })], { signedTx: async () => null, pendingTx: async () => "0200", txVerdict: async () => "signed" });
      await rebroadcastOnce(d);
      expect(log.updates).toEqual([]);
    });
    const old = (o: Partial<Payout> = {}) => row({ outcome: "releasing", ts: new Date(NOW - 16 * 60_000).toISOString(), ...o });
    test("no release tx hash was ever written and no pending_tx: release_failed, alert, that attempt's lock freed", async () => {
      const { d, log } = rig([old({ tier: 2 })], { signedTx: async () => null });
      expect(await rebroadcastOnce(d)).toMatchObject({ reconciled: 1 });
      expect(log.updates).toEqual([[ID, { outcome: "release_failed", reply: COPY_FAILED }]]);
      expect(log.alerts[0]![0]).toBe("release_failed");
      expect(log.settled).toEqual([[2, ID]]);
      expect(log.broadcasts).toEqual([]);
      expect(log.verdicts).toEqual([]); // nothing to ask about
    });
    for (const v of ["failed", "null", "expired"] as const) {
      test(`a hash that is ${v}: release_failed`, async () => {
        const { d, log } = rig([old({ release_tx: "H".repeat(44), release_ref_height: 500 })], { signedTx: async () => null, txVerdict: async () => v });
        expect(await rebroadcastOnce(d)).toMatchObject({ reconciled: 1 });
        expect(log.updates).toEqual([[ID, { outcome: "release_failed", reply: COPY_FAILED }]]);
      });
    }
    for (const v of ["notfinal", "unknown", "signed"] as const) {
      test(`a hash that is ${v}: never reconciled`, async () => {
        const { d, log } = rig([old({ release_tx: "H".repeat(44), release_ref_height: 500 })], { signedTx: async () => null, txVerdict: async () => v });
        expect(await rebroadcastOnce(d)).toMatchObject({ reconciled: 0, waiting: 1 });
        expect(log.updates).toEqual([]);
        expect(log.settled).toEqual([]);
      });
    }
    test("a hash with no reference height can never count as expired", async () => {
      const { d, log } = rig([old({ release_tx: "H".repeat(44), release_ref_height: null })], { signedTx: async () => null, txVerdict: async () => "unknown" });
      await rebroadcastOnce(d);
      expect(log.updates).toEqual([]);
    });
    test("a pending_tx and a FINAL signed release tx: promoted to signed_pending_broadcast, then rebroadcast", async () => {
      const { d, log } = rig([old({ release_tx: "H".repeat(44), release_ref_height: 9 })], { signedTx: async () => null, recover: async () => ({ chain: "btc", hex: "beef" }), pendingTx: async () => "0200", txVerdict: async () => "signed" });
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1, reconciled: 0 });
      expect(log.updates.map(u => u[1].outcome)).toEqual(["signed_pending_broadcast", "drained"]);
    });
    test("a pending_tx alone is not a signature: while the release tx is not final success the row stays releasing, uncounted (B1 route 2)", async () => {
      for (const v of ["notfinal", "unknown"] as const) {
        const { d, log } = rig([old({ release_tx: "H".repeat(44), release_ref_height: 9 })], { signedTx: async () => null, pendingTx: async () => "0200", txVerdict: async () => v });
        expect(await rebroadcastOnce(d)).toMatchObject({ settled: 0, reconciled: 0, waiting: 1, failed: 0 });
        expect(log.updates).toEqual([]);
        expect(log.settled).toEqual([]);
      }
      const noHash = rig([old({ release_tx: null })], { signedTx: async () => null, pendingTx: async () => "0200" });
      expect(await rebroadcastOnce(noHash.d)).toMatchObject({ waiting: 1 });
      expect(noHash.log.updates).toEqual([]);
    });
    // N2b: a dead release tx with the pending_tx still set (on_signed out of gas, GC'd tx): counted every tick, terminal after 10, lock kept
    for (const v of ["failed", "null", "expired"] as const) {
      test(`a pending_tx and a ${v} release tx: a failure each tick; the tenth is terminal, alerted with the class only, lock kept (no hex)`, async () => {
        const { d, log } = rig([old({ release_tx: "H".repeat(44), release_ref_height: 9 })], { signedTx: async () => null, pendingTx: async () => "0200", txVerdict: async () => v });
        for (let i = 0; i < 9; i++) expect(await rebroadcastOnce(d)).toMatchObject({ failed: 1, terminal: 0 });
        expect(log.updates).toEqual([[ID, { outcome: "signed_pending_broadcast" }]]); // pending_tx proves the contract took the request; the store only allows terminal from here
        expect(await rebroadcastOnce(d)).toMatchObject({ failed: 1, terminal: 1 });
        expect(log.updates.at(-1)).toEqual([ID, { outcome: "broadcast_failed_terminal" }]);
        expect(log.alerts.map(a => a[0])).toEqual(["broadcast_failed_terminal"]);
        expect(JSON.stringify(log.alerts)).not.toContain("0200");
        expect(log.settled).toEqual([]);
      });
    }
    // N2c: the contract signed (the hex is stored) and the release tx is gone: promoted and broadcast whatever the verdict
    test("a stored signed hex on a stale releasing row: promoted and broadcast, the verdict is not asked", async () => {
      const { d, log } = rig([old({ release_tx: "H".repeat(44), release_ref_height: 9 })], { pendingTx: async () => "0200", txVerdict: async () => { throw new Error("must not be asked"); } });
      expect(await rebroadcastOnce(d)).toMatchObject({ settled: 1, failed: 0 });
      expect(log.updates.map(u => u[1].outcome)).toEqual(["signed_pending_broadcast", "drained"]);
    });
    test("N4: the release tx is read before pending_tx", async () => {
      const order: string[] = [];
      const { d } = rig([old({ release_tx: "H".repeat(44), release_ref_height: 9 })], { signedTx: async () => null, txVerdict: async () => (order.push("verdict"), "notfinal"), pendingTx: async () => (order.push("pending"), null) });
      await rebroadcastOnce(d);
      expect(order).toEqual(["verdict", "pending"]);
    });
    test("younger than 15 minutes is left alone", async () => {
      const { d, log } = rig([old({ ts: new Date(NOW - 14 * 60_000).toISOString() })]);
      await rebroadcastOnce(d);
      expect(log.updates).toEqual([]);
    });
    test("a pending_tx or verdict check that fails changes nothing", async () => {
      const a = rig([old()], { signedTx: async () => null, pendingTx: async () => { throw new Error("rpc down"); } });
      await rebroadcastOnce(a.d);
      expect(a.log.updates).toEqual([]);
      const b = rig([old({ release_tx: "H".repeat(44), release_ref_height: 5 })], { signedTx: async () => null, txVerdict: async () => { throw new Error("rpc down"); } });
      await rebroadcastOnce(b.d);
      expect(b.log.updates).toEqual([]);
    });
  });
});

// Waits for a condition, never for a fixed time: a loaded machine only makes it slower, not wrong.
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 1000 && !ok(); i++) await Bun.sleep(5);
  expect(ok()).toBe(true);
};

describe("startRebroadcast", () => {
  test("first run soon after start (firstMs), then on the interval, never overlapping, and stops", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const { d } = rig([], { payouts: async () => (calls++, gate.then(() => [])) });
    const stop = startRebroadcast({ ...d, intervalMs: 5_000, firstMs: 5 });
    await until(() => calls >= 1);
    await Bun.sleep(20);
    expect(calls).toBe(1); // the first run came long before the 5 s interval, and is still going
    release();
    await stop.idle();
    stop();
    const n = calls;
    await Bun.sleep(30);
    expect(calls).toBe(n);
  });
  test("a failing run is reported and the loop keeps going", async () => {
    const seen: string[] = [];
    const { d } = rig([], { payouts: async () => { throw new Error("db down"); }, warn: w => void seen.push(w) });
    const stop = startRebroadcast({ ...d, intervalMs: 5, firstMs: 1 });
    await until(() => seen.length >= 2);
    stop();
    await stop.idle();
  });
  test("stop() before the first run cancels it", async () => {
    let calls = 0;
    const { d } = rig([], { payouts: async () => (calls++, []) });
    const stop = startRebroadcast({ ...d, intervalMs: 5_000, firstMs: 20 });
    stop();
    await Bun.sleep(60);
    await stop.idle();
    expect(calls).toBe(0);
  });
});

describe("makeChainDeps", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const cfg = { network: "testnet", nearRpc: "https://rpc.test", vaultAccount: "v.testnet", agentAccount: "a.testnet", agentPrivateKey: kp.toString(), mempoolBase: "https://m.test/api", baseRpc: "", btcHrp: "tb" } as unknown as Config;
  const db = { putSignedTx: async () => true, getSignedTx: async () => null, updateAttempt: async () => {}, markSent: async () => {}, listPayouts: async () => [] as any[], counter: memoryCounter() };

  test("fits the ChainDeps of server.ts (all but viewAccessKey)", () => {
    const chain: Omit<ChainDeps, "viewAccessKey"> = makeChainDeps(cfg, { db, onSettled: () => {} });
    expect(Object.keys(chain)).toEqual(expect.arrayContaining(["release", "tierOpen", "wasSigned", "storeSignedTx", "startRebroadcast", "pendingPayouts", "check"]));
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
  test("pendingPayouts asks the indexed work list and keeps releasing and signed_pending_broadcast rows only", async () => {
    const asked: string[] = [];
    const rows: any[] = [
      { id: "a", tier: 1, outcome: "drained", ts: "t", near_tx: null, release_tx: null, release_ref_height: null },
      { id: "b", tier: 1, outcome: "signed_pending_broadcast", ts: "t", near_tx: "n", release_tx: "h", release_ref_height: 5 },
      { id: "c", tier: 3, outcome: "releasing", ts: "t", near_tx: null, release_tx: null, release_ref_height: null },
    ];
    const chain = makeChainDeps(cfg, { db: { ...db, listPayouts: async s => (asked.push(s), rows) }, onSettled: () => {}, clock: () => NOW });
    expect((await chain.pendingPayouts()).map(p => p.id)).toEqual(["b", "c"]);
    expect(asked).toEqual([new Date(NOW - 24 * 3600_000).toISOString()]); // bounded drained lookback, no export scan
  });
  test("with no Base RPC, an EVM payout fails cleanly instead of crashing", async () => {
    const warns: string[] = [];
    const counter = memoryCounter();
    const chain = makeChainDeps(cfg, {
      db: { ...db, counter, getSignedTx: async () => ({ chain: "evm", hex: "0x02" }), listPayouts: async () => [{ id: ID, tier: 2, outcome: "signed_pending_broadcast", ts: "t", near_tx: null, release_tx: null, release_ref_height: null }] },
      onSettled: () => {},
    });
    const stop = chain.startRebroadcast({ alert: () => {}, intervalMs: 5_000, firstMs: 1, warn: w => void warns.push(w) });
    for (let i = 0; i < 1000 && warns.length === 0; i++) await Bun.sleep(5);
    stop();
    await stop.idle();
    const n = await counter.get(`rebroadcast:${ID}`);
    expect(n).toBe(0); // L3: no Base RPC is configuration, not a failed payout: warned about each tick, never counted toward terminal
    expect(warns.length).toBeGreaterThan(0);
  });
});
