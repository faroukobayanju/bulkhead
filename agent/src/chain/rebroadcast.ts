// The rebroadcast loop (E6). It runs inside the agent process, because only that process can free the tier lock (onSettled).
// Work list: attempt rows still in `releasing` or `signed_pending_broadcast`, checked against the contract (get_pending_tx) and joined
// with the stored signed hex. A signed payout is broadcast again until it lands (drained) or fails 10 times (broadcast_failed_terminal,
// alert, and the documented fix is the owner's emergency withdraw). When the signed hex was never stored, it is read back from the
// final NEAR release tx (recover). A `releasing` row is closed as failed only when nothing can still sign for it.
import type { Counter } from "../counter";
import type { AttemptPatch } from "../db";

export type Payout = {
  id: string;
  tier: 1 | 2 | 3;
  outcome: "releasing" | "signed_pending_broadcast";
  ts: string;
  near_tx?: string | null;
  release_tx?: string | null; // the NEAR tx hash of the release call, written before it was sent
  release_ref_height?: number | null;
};
export type Verdict = "signed" | "failed" | "null" | "notfinal" | "unknown" | "expired";
export type RebroadcastDeps = {
  payouts: () => Promise<Payout[]>;
  signedTx: (id: string) => Promise<{ chain: "btc" | "evm"; hex: string } | null>;
  storeSignedTx: (id: string, chain: "btc" | "evm", hex: string) => Promise<unknown>;
  // The signed tx read back from the final NEAR release tx (checked against the tier key), or null while it is not final.
  recover: (p: Payout) => Promise<{ chain: "btc" | "evm"; hex: string } | null>;
  pendingTx: (id: string) => Promise<string | null>; // the contract's get_pending_tx
  txVerdict: (hash: string, refHeight: number) => Promise<Verdict>;
  broadcast: (chain: "btc" | "evm", hex: string) => Promise<string>; // returns the chain txid; "already known" counts as sent
  update: (id: string, patch: AttemptPatch) => Promise<void>;
  failures: Counter; // survives restarts when it is the Convex counter
  alert: (kind: string, details: Record<string, unknown>) => void | Promise<void>;
  onSettled: (tier: 1 | 2 | 3, attemptId: string) => void; // frees the process-local tier lock, only if this attempt holds it
  warn?: (what: string, id: string, e: unknown) => void;
  clock?: () => number;
  maxFailures?: number;
  staleMs?: number;
};

// A `releasing` row is old enough to settle after 15 minutes. Even then it is only closed as failed when the contract has no
// pending_tx for it AND either no release tx hash was ever written (nothing left the process), or that tx is final and failed, or
// the node does not know it and it is past its validity. A hash that is still running is never closed.
const STALE_MS = 15 * 60_000;
const DEAD = new Set<Verdict>(["failed", "null", "expired"]); // the release tx can never sign anything

export async function rebroadcastOnce(d: RebroadcastDeps) {
  const now = d.clock ?? Date.now;
  const max = d.maxFailures ?? 10;
  const stale = d.staleMs ?? STALE_MS;
  const r = { settled: 0, failed: 0, terminal: 0, reconciled: 0, waiting: 0 };
  const verdictOf = (p: Payout) => d.txVerdict(p.release_tx!, p.release_ref_height ?? Number.MAX_SAFE_INTEGER); // no height: never "expired"
  // The attempt never signed: the row closes, the tier reopens (the contract has no pending_tx for it), and the operator is told.
  const neverSigned = async (p: Payout, reason: string) => {
    await d.update(p.id, { outcome: "release_failed" });
    await d.alert("release_failed", { attempt_id: p.id, tier: p.tier, reason });
    d.onSettled(p.tier, p.id);
    r.reconciled++;
  };
  for (const p of await d.payouts()) {
    try {
      let outcome = p.outcome;
      if (outcome === "releasing") {
        if (await d.pendingTx(p.id)) {
          // pending_tx shows from the moment the contract takes the request, while the signer may still fail. Only a release tx that
          // is FINAL with a signature makes this a signed payout.
          if (!p.release_tx || (await verdictOf(p)) !== "signed") {
            r.waiting++;
            continue;
          }
          await d.update(p.id, { outcome: "signed_pending_broadcast" }); // the contract signed and the agent lost the answer
          outcome = "signed_pending_broadcast";
        } else if (now() - Date.parse(p.ts) >= stale) {
          if (p.release_tx && !DEAD.has(await verdictOf(p))) {
            r.waiting++;
            continue;
          }
          await neverSigned(p, "stale_releasing");
          continue;
        } else continue;
      }
      let txid: string | null = null;
      let err: unknown;
      try {
        let stx = await d.signedTx(p.id);
        if (!stx && !p.release_tx && !(await d.pendingTx(p.id))) {
          // wasSigned could not tell, but no release call was ever sent and the contract holds nothing for this attempt
          await neverSigned(p, "never_sent");
          continue;
        }
        if (!stx && p.release_tx) {
          stx = await d.recover(p);
          if (!stx) {
            // not final, never signed, or still running: only a release tx that can never sign, with no pending_tx, closes the row
            const dead = DEAD.has(await verdictOf(p)) && !(await d.pendingTx(p.id));
            if (dead) await neverSigned(p, "never_signed");
            else r.waiting++;
            continue;
          }
          await Promise.resolve(d.storeSignedTx(p.id, stx.chain, stx.hex)).catch(e => d.warn?.("store_failed", p.id, e));
        }
        if (!stx) throw new Error("no signed tx stored for this attempt");
        txid = await d.broadcast(stx.chain, stx.hex);
      } catch (e) {
        err = e;
      }
      if (txid !== null) {
        await d.update(p.id, { outcome: "drained", chain_txid: txid });
        d.onSettled(p.tier, p.id);
        r.settled++;
        continue;
      }
      if (err === undefined) continue; // closed above
      r.failed++;
      const n = await d.failures.add(`rebroadcast:${p.id}`, 1);
      if (n !== null && n >= max) {
        await d.update(p.id, { outcome: "broadcast_failed_terminal" });
        await d.alert("broadcast_failed_terminal", { attempt_id: p.id, tier: p.tier, near_tx: p.near_tx ?? p.release_tx ?? null, attempts: n, error: String((err as Error)?.message ?? err).slice(0, 200), fix: "owner emergency withdraw" });
        d.onSettled(p.tier, p.id); // the lock goes; the coin and nonce stay excluded from later releases (the signed tx may still land)
        r.terminal++;
      }
    } catch (e) {
      d.warn?.("rebroadcast_row_failed", p.id, e); // one bad row must not stop the others; a row that left `releasing` meanwhile is refused by the store
    }
  }
  return r;
}

/** Runs rebroadcastOnce soon after start (`firstMs`, 10 s) and then every `intervalMs` (5 minutes), never two at once. Returns the stop function. */
export function startRebroadcast(d: RebroadcastDeps & { intervalMs?: number; firstMs?: number }): (() => void) & { idle: () => Promise<void> } {
  let running = false;
  let current: Promise<void> = Promise.resolve();
  const tick = () => {
    if (running) return;
    running = true;
    current = (async () => {
      try {
        await rebroadcastOnce(d);
      } catch (e) {
        d.warn?.("rebroadcast_failed", "", e);
      } finally {
        running = false;
      }
    })();
  };
  const interval = d.intervalMs ?? 300_000;
  const first = setTimeout(tick, d.firstMs ?? 10_000);
  const t = setInterval(tick, interval);
  // stop() cancels the timers; idle() resolves when a run that was already going has finished
  return Object.assign(() => (clearTimeout(first), clearInterval(t)), { idle: () => current });
}
