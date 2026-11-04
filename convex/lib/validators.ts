import { v, type Validator } from "convex/values";
import { OUTCOMES, STAGES } from "../../shared/attempt";

// A union of string literals, typed as the union of its members.
export const oneOf = <const T extends string>(xs: readonly T[]): Validator<T, "required", never> =>
  (v.union as (...m: unknown[]) => Validator<T, "required", never>)(...xs.map(x => v.literal(x)));
export const nullable = <T extends Validator<any, "required", any>>(x: T) => v.union(x, v.null());

export const tier = v.union(v.literal(1), v.literal(2), v.literal(3));
export const outcome = oneOf(OUTCOMES);
export const stage = oneOf(STAGES);
export const verdict = oneOf(["allow", "escalate", "block"]);

// A stored checkpoint result. `reason` is kept for the dataset and is never returned by a public query.
export const fwResult = v.object({
  verdict,
  risk: v.number(),
  technique: v.string(),
  reason: v.string(),
  firewall_version: v.string(),
  codehash: v.string(),
  latency_ms: v.number(),
  degraded: v.boolean(),
});

// The columns of an attempt as the agent writes it (spec 3.7 with E6, E7, E8 and E20). Everything the agent computes is here;
// `hidden` is not: only a report or an admin changes it.
export const attemptFields = {
  id: v.string(), // ULID
  ts: v.string(), // ISO-8601 UTC with milliseconds
  tier,
  account_hash: v.string(), // sha256(account + pepper); the raw account never reaches Convex
  ip_hash: v.string(),
  message: v.string(),
  normalized: v.string(),
  fw_a: nullable(fwResult),
  // JSON text of the raw assistant message. Text, not a nested value: model output can hold keys Convex refuses ($-names) or nest too deep.
  // null when the model never ran (blocked_a). Spec 3.7 says not null, which cannot hold for a row the firewall stopped before the model.
  llm_output: nullable(v.string()),
  tool_called: v.boolean(),
  fw_b: nullable(fwResult),
  outcome,
  technique: nullable(v.string()),
  prompt_sha256: v.string(),
  model_id: v.string(),
  attestation_sha256: v.string(),
  codehash: v.string(),
  near_tx: nullable(v.string()),
  chain_txid: nullable(v.string()),
  payout_address: v.string(),
  consent_version: v.string(),
  reply: v.string(), // the outcome copy the player sees, so a subscriber can show the result
  stage,
  leaf: v.string(), // E7: written once at insert, never updated
  // E5 and E17, optional so older rows stay valid. signature: ed25519 over the canonical public row (shared/attempt-view.ts) by the
  // agent key `signer`, rewritten whenever the outcome changes. response_verified: every model response of the attempt carried a
  // signature that checked out against the attested signer.
  signature: v.optional(v.string()),
  signer: v.optional(v.string()),
  response_verified: v.optional(v.boolean()),
  // Recovery state (E6), not public and not signed: the NEAR tx hash of the release call and the block height it refers to, written
  // before the call is sent, so a restart can tell a payout in flight from one that never left.
  release_tx: v.optional(v.string()),
  release_ref_height: v.optional(v.number()),
  // When the payout settled (drained, failed or terminal), set by `finish`: the exclusion window of spent coins counts from here.
  settled_at: v.optional(v.string()),
};
