// What a browser may see of an attempt: an explicit list of fields, built one by one, never a spread of the stored row.
// Not here, on purpose: ip_hash, account_hash, hidden, llm_output, normalized, payout_address, the hashes and codehash, and the
// firewall `reason` (the next day's dataset publishes full reasons). A new column stays private until it is added below.
import type { DocumentByName } from "convex/server";
import type { DataModel } from "./server";

type Attempt = DocumentByName<DataModel, "attempts">;
type Fw = Attempt["fw_a"];

// Picked field by field, so a key the stored object happens to carry (a reason, however nested) cannot come along.
const fw = (x: Fw) => (x ? { verdict: x.verdict, risk: x.risk, technique: x.technique, firewall_version: x.firewall_version, degraded: x.degraded } : null);

// The leaderboard shows the winner's payout address, shortened, and the near-miss list shows who nearly won. No other row shows one.
const SHOWS_PAYOUT = new Set(["drained", "signed_pending_broadcast", "blocked_b"]);
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-3)}` : null);

export const publicAttempt = (d: Attempt) => ({
  id: d.id,
  ts: d.ts,
  tier: d.tier,
  outcome: d.outcome,
  stage: d.stage,
  message: d.message,
  reply: d.reply,
  technique: d.technique,
  tool_called: d.tool_called,
  fw_a: fw(d.fw_a),
  fw_b: fw(d.fw_b),
  near_tx: d.near_tx,
  chain_txid: d.chain_txid,
  payout: SHOWS_PAYOUT.has(d.outcome) ? short(d.payout_address) : null,
});
