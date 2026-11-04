// The rebroadcast loop (E6). It runs inside the agent process, because only that process can free the tier lock (onSettled).
// Work list: attempt rows still in `releasing` or `signed_pending_broadcast`, checked against the contract (get_pending_tx) and joined
// with the stored signed hex. A signed payout is broadcast again until it lands (drained) or fails 10 times (broadcast_failed_terminal,
// alert, and the documented fix is the owner's emergency withdraw). When the signed hex was never stored, it is read back from the
// final NEAR release tx (recover). A `releasing` row is closed as failed only when nothing can still sign for it.
import type { Counter } from "../counter";
import type { AttemptPatch } from "../db";
import { COPY } from "../pipeline";

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
  // Base only: has the tx (by its signed hex) mined, and with what result. Absent: a broadcast counts as settled (Bitcoin).
  receipt?: (hex: string) => Promise<{ status: "success" | "pending" | "reverted"; txid: string }>;
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
const LIVE_MS = 2 * 60_000; // a releasing row this young belongs to a running pipeline (its release wait ends at 120 s)
const DEAD = new Set<Verdict>(["failed", "null", "expired"]); // the release tx can never sign anything

export async function rebroadcastOnce(d: RebroadcastDeps) {
  const now = d.clock ?? Date.now;
  const max = d.maxFailures ?? 10;
  const stale = d.staleMs ?? STALE_MS;
  const r = { settled: 0, failed: 0, terminal: 0, reconciled: 0, waiting: 0 };
  const verdictOf = (p: Payout) => d.txVerdict(p.release_tx!, p.release_ref_height ?? Number.MAX_SAFE_INTEGER); // no height: never "expired"
  // The attempt never signed: the row closes, the tier reopens (the contract has no pending_tx for it), and the operator is told.
  const neverSigned = async (p: Payout, reason: string) => {
    await d.update(p.id, { outcome: "release_failed", reply: COPY.failed });
    await d.alert("release_failed", { attempt_id: p.id, tier: p.tier, reason });
    d.onSettled(p.tier, p.id);
    r.reconciled++;
  };
  // The contract signed (or may have) and this tick got nowhere: a failure, and the tenth is terminal. Alerts carry a code or class,
  // never a message. With a stored hex the lock goes (the coin stays excluded, btc); without one nothing is known about what the
  // payout spends, so the lock stays until the owner acts.
  // ponytail: the kept lock is process-local; after a restart that row no longer holds the tier. Persist it if restarts matter here.
  const count = async (p: Payout, code: string, hex: boolean) => {
    r.failed++;
    const n = await d.failures.add(`rebroadcast:${p.id}`, 1);
    if (n === null || n < max) return;
    await d.update(p.id, { outcome: "broadcast_failed_terminal" });
    await d.alert("broadcast_failed_terminal", { attempt_id: p.id, tier: p.tier, near_tx: p.near_tx ?? p.release_tx ?? null, attempts: n, error: code, fix: hex ? "owner emergency withdraw" : "owner action needed: no signed tx known, the tier stays locked" });
    if (hex) d.onSettled(p.tier, p.id);
    r.terminal++;
  };
  const drained = async (p: Payout, txid: string, evm = false) => {
    await d.update(p.id, { outcome: "drained", chain_txid: txid, reply: COPY.paid }); // the "being broadcast" text no longer holds
    d.onSettled(p.tier, p.id);
    r.settled++;
    // a Bitcoin payout is alerted by the pipeline that made it; a Base one settles here, so this is the operator's only word of it
    if (evm) await d.alert("drained", { attempt_id: p.id, tier: p.tier, near_tx: p.near_tx ?? null, chain_txid: txid });
  };
  for (const p of await d.payouts()) {
    try {
      let stx = await d.signedTx(p.id);
      let stored = true; // the hex is in the store (a recovered one only once the write went through)
      const old = now() - Date.parse(p.ts) >= stale;
      if (p.outcome === "releasing") {
        if (now() - Date.parse(p.ts) < LIVE_MS) continue; // the pipeline that made this row is still running
        // a stored hex exists only after release_signed: the contract signed, whatever became of the release tx
        if (stx) {
          if (!old) continue;
        } else {
          const v = p.release_tx ? await verdictOf(p) : null; // the tx before pending_tx, as wasSigned does
          if (await d.pendingTx(p.id)) {
            // pending_tx shows from the moment the contract takes the request, while the signer may still fail. Only a release tx that
            // is FINAL with a signature makes this a signed payout; one that can never sign while pending_tx stays is a counted failure.
            if (v !== "signed") {
              if (v && DEAD.has(v)) {
                // pending_tx proves the contract recorded the request: a payout that may be signed. The store only allows terminal from here.
                await d.update(p.id, { outcome: "signed_pending_broadcast" });
                await count(p, `release_tx_${v}`, false);
              } else r.waiting++;
              continue;
            }
          } else if (!old) continue;
          else if (p.release_tx && !DEAD.has(v!)) {
            r.waiting++;
            continue;
          } else {
            await neverSigned(p, "stale_releasing");
            continue;
          }
        }
        await d.update(p.id, { outcome: "signed_pending_broadcast" }); // the contract signed and the agent lost the answer
      }
      if (!stx && !p.release_tx) {
        // wasSigned could not tell, but no release call was ever sent and the contract holds nothing for this attempt
        if (await d.pendingTx(p.id)) await count(p, "NoSignedTx", false);
        else await neverSigned(p, "never_sent");
        continue;
      }
      if (!stx) {
        try {
          stx = await d.recover(p);
        } catch (e) {
          if ((e as Error)?.name !== "SignatureError") throw e; // RPC trouble is the node's, not the payout's: warned, never counted
          await count(p, "SignatureError", false);
          continue;
        }
        if (!stx) {
          // not final, never signed, or still running: only a release tx that can never sign, with no pending_tx, closes the row
          const v = await verdictOf(p);
          const pending = await d.pendingTx(p.id);
          if (!DEAD.has(v)) r.waiting++;
          else if (pending) await count(p, `release_tx_${v}`, false);
          else await neverSigned(p, "never_signed");
          continue;
        }
        await Promise.resolve(d.storeSignedTx(p.id, stx.chain, stx.hex)).catch(e => ((stored = false), d.warn?.("store_failed", p.id, e)));
      }
      if (stx.chain === "evm" && d.receipt) {
        // a Base tx in the mempool is not a payout (it may revert or be dropped), and a mined one must never be counted as a failed
        // broadcast: the receipt comes first
        const rc = await d.receipt(stx.hex);
        if (rc.status === "success") {
          await drained(p, rc.txid, true);
          continue;
        }
        if (rc.status === "reverted") {
          await d.update(p.id, { outcome: "broadcast_failed_terminal" });
          await d.alert("broadcast_failed_terminal", { attempt_id: p.id, tier: p.tier, near_tx: p.near_tx ?? p.release_tx ?? null, error: "reverted", fix: "owner action needed: the transfer reverted on Base, the tier stays locked" });
          r.terminal++; // the lock stays: the contract signed and the tier is not safe to reopen unattended
          continue;
        }
      }
      let txid: string;
      try {
        txid = await d.broadcast(stx.chain, stx.hex);
      } catch (e) {
        await count(p, (e as Error)?.name ?? "Error", stored);
        continue;
      }
      if (stx.chain === "evm" && d.receipt) {
        r.waiting++; // sent; settles on a later tick, when the receipt says success
        // still unmined long after the broadcast succeeded (fee below the base fee, a node that keeps dropping it): tell the operator once
        if (old && (await d.failures.add(`stalled:${p.id}`, 1)) === 1) await d.alert("base_tx_stalled", { attempt_id: p.id, tier: p.tier });
      }
      else await drained(p, txid);
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
