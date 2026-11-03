// The public face of an attempt row, in one place so the agent that signs it (E5) and the Convex query that serves it cannot drift.
// No imports and no node: APIs: Convex bundles this file for its own runtime.
// Not in the view, on purpose: ip_hash, account_hash, hidden, llm_output, normalized, the hashes and codehash, and the firewall `reason`.
// `stage` is progress, not record, so it is public but is not signed (it moves after the row is written).

type Fw = { verdict: string; risk: number; technique: string; firewall_version: string; degraded: boolean } | null | undefined;
export type ViewInput = {
  id: string;
  ts: string;
  tier: 1 | 2 | 3;
  outcome: string;
  message: string;
  reply: string;
  technique: string | null;
  tool_called: boolean;
  fw_a: Fw;
  fw_b: Fw;
  near_tx: string | null;
  chain_txid: string | null;
  payout_address: string;
  response_verified?: boolean | null;
};

// Picked field by field, so a key the stored object happens to carry (a reason, however nested) cannot come along.
const fw = (x: Fw) => (x ? { verdict: x.verdict, risk: x.risk, technique: x.technique, firewall_version: x.firewall_version, degraded: x.degraded } : null);

// Only a winner's payout address is shown, shortened: it is on-chain anyway. A near miss never paid, so its address stays private.
const SHOWS_PAYOUT = new Set(["drained", "signed_pending_broadcast"]);
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-3)}` : null);

// What the agent signs: every public field except stage, plus response_verified (E17). A verifier takes the public row, drops
// `stage` and `signature`, and checks the ed25519 signature over its canonical JSON with `signer` inside.
export const attemptView = (d: ViewInput) => ({
  id: d.id,
  ts: d.ts,
  tier: d.tier,
  outcome: d.outcome,
  message: d.message,
  reply: d.reply,
  technique: d.technique ?? null,
  tool_called: d.tool_called,
  fw_a: fw(d.fw_a),
  fw_b: fw(d.fw_b),
  near_tx: d.near_tx ?? null,
  chain_txid: d.chain_txid ?? null,
  payout: SHOWS_PAYOUT.has(d.outcome) ? short(d.payout_address) : null,
  response_verified: d.response_verified ?? null,
});
