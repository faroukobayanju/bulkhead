// What an attempt row can say, shared by the agent, the Convex functions and Task 11's scripts.
// No imports and no node: APIs: Convex bundles this file for its own runtime.

export const OUTCOMES = [
  "refused",
  "blocked_a",
  "blocked_b",
  "tool_error",
  "releasing", // written before `release` is called, so a payout cannot happen without a row
  "drained", // won a round
  "signed_pending_broadcast",
  "broadcast_failed_terminal",
  "release_failed",
  "won_race_lost",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

// The outcomes one payout attempt moves through. Everything else is final when the row is inserted.
export const PAYOUT_OUTCOMES = ["releasing", "drained", "signed_pending_broadcast", "broadcast_failed_terminal", "release_failed"] as const satisfies readonly Outcome[];

// The only changes allowed to an outcome after insert. `releasing` becomes what the release did; the rebroadcast loop settles a
// signed payout. Nothing leaves `drained`, `release_failed` or `broadcast_failed_terminal`.
export const TRANSITIONS: Readonly<Record<string, readonly Outcome[]>> = {
  releasing: ["drained", "signed_pending_broadcast", "release_failed"],
  // release_failed from a signed row: the payout was never signed after all (the signer failed after the request showed pending_tx);
  // the agent only asks for it when the release tx is final-failed, null or expired and the contract has no pending_tx
  signed_pending_broadcast: ["drained", "broadcast_failed_terminal", "release_failed"],
};

// In the order an attempt passes through them. A stage only moves forward.
export const STAGES = ["reading", "firewall_a", "thinking", "firewall_b", "signing", "broadcasting", "done"] as const;
export type Stage = (typeof STAGES)[number];

export const MAX_MESSAGE = 2000;
