// The rebroadcast loop (E6). It runs inside the agent process, because only that process can free the tier lock (onSettled).
// Work list: attempt rows still in `releasing` or `signed_pending_broadcast`, checked against the contract (get_pending_tx) and joined
// with the stored signed hex. A signed payout is broadcast again until it lands (drained) or fails 10 times (broadcast_failed_terminal,
// alert, and the documented fix is the owner's emergency withdraw). A `releasing` row the contract never signed is closed as failed.
import type { Counter } from "../counter";
import type { AttemptPatch } from "../db";

export type Payout = { id: string; tier: 1 | 2 | 3; outcome: "releasing" | "signed_pending_broadcast"; ts: string; near_tx?: string | null };
export type RebroadcastDeps = {
  payouts: () => Promise<Payout[]>;
  signedTx: (id: string) => Promise<{ chain: "btc" | "evm"; hex: string } | null>;
  pendingTx: (id: string) => Promise<string | null>; // the contract's get_pending_tx
  broadcast: (chain: "btc" | "evm", hex: string) => Promise<string>; // returns the chain txid; "already known" counts as sent
  update: (id: string, patch: AttemptPatch) => Promise<void>;
  failures: Counter; // survives restarts when it is the Convex counter
  alert: (kind: string, details: Record<string, unknown>) => void | Promise<void>;
  onSettled: (tier: 1 | 2 | 3) => void; // frees the process-local tier lock
  warn?: (what: string, id: string, e: unknown) => void;
  clock?: () => number;
  maxFailures?: number;
  staleMs?: number;
};

// ponytail: a `releasing` row with no pending_tx after 15 minutes is treated as never signed. A NEAR tx that is not included within
// minutes has left the node pools; its hard expiry is 86,400 blocks, so this is a bet on that, taken only after the row is old.
const STALE_MS = 15 * 60_000;

export async function rebroadcastOnce(d: RebroadcastDeps) {
  const now = d.clock ?? Date.now;
  const max = d.maxFailures ?? 10;
  const stale = d.staleMs ?? STALE_MS;
  const r = { settled: 0, failed: 0, terminal: 0, reconciled: 0 };
  for (const p of await d.payouts()) {
    try {
      let outcome = p.outcome;
      if (outcome === "releasing") {
        if (await d.pendingTx(p.id)) {
          await d.update(p.id, { outcome: "signed_pending_broadcast" }); // the contract signed and the agent lost the answer
          outcome = "signed_pending_broadcast";
        } else if (now() - Date.parse(p.ts) >= stale) {
          await d.update(p.id, { outcome: "release_failed" });
          await d.alert("release_failed", { attempt_id: p.id, tier: p.tier, reason: "stale_releasing" });
          d.onSettled(p.tier);
          r.reconciled++;
          continue;
        } else continue;
      }
      let txid: string | null = null;
      let err: unknown;
      try {
        const stx = await d.signedTx(p.id);
        if (!stx) throw new Error("no signed tx stored for this attempt");
        txid = await d.broadcast(stx.chain, stx.hex);
      } catch (e) {
        err = e;
      }
      if (txid !== null) {
        await d.update(p.id, { outcome: "drained", chain_txid: txid });
        d.onSettled(p.tier);
        r.settled++;
        continue;
      }
      r.failed++;
      const n = await d.failures.add(`rebroadcast:${p.id}`, 1);
      if (n !== null && n >= max) {
        await d.update(p.id, { outcome: "broadcast_failed_terminal" });
        await d.alert("broadcast_failed_terminal", { attempt_id: p.id, tier: p.tier, near_tx: p.near_tx ?? null, attempts: n, error: String((err as Error)?.message ?? err).slice(0, 200), fix: "owner emergency withdraw" });
        r.terminal++;
      }
    } catch (e) {
      d.warn?.("rebroadcast_row_failed", p.id, e); // one bad row must not stop the others
    }
  }
  return r;
}

/** Runs rebroadcastOnce every `intervalMs` (5 minutes), never two at once. Returns the stop function. */
export function startRebroadcast(d: RebroadcastDeps & { intervalMs?: number }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await rebroadcastOnce(d);
    } catch (e) {
      d.warn?.("rebroadcast_failed", "", e);
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), d.intervalMs ?? 300_000);
  return () => clearInterval(t);
}
