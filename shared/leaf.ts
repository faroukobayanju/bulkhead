// The Merkle leaf of an attempt (E7), fixed so the agent that writes it and Task 11's verify-roots compute the same bytes.
// Pure and without node: APIs, so a script, the agent and a browser can all import it.
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { PAYOUT_OUTCOMES } from "./attempt";

export type LeafInput = {
  id: string; // ULID
  ts: string; // ISO-8601 UTC with milliseconds, as isoMs writes it
  tier: number;
  account_hash: string;
  message: string;
  outcome: string;
  prompt_sha256: string;
  model_id: string;
  attestation_sha256: string;
  codehash: string;
};

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const isoMs = (ms: number) => new Date(ms).toISOString();

// A payout row is inserted as `releasing` and later becomes drained, signed_pending_broadcast, release_failed or
// broadcast_failed_terminal. The leaf is written once and the row's outcome changes afterwards, so every one of those maps to
// "releasing": a verifier that recomputes the leaf from the final row gets the leaf that was committed. What the release did
// is settled by the contract's events, not by this leaf. Every other outcome is final at insert, so it is covered as it is.
export const leafOutcome = (outcome: string) => ((PAYOUT_OUTCOMES as readonly string[]).includes(outcome) ? "releasing" : outcome);

export function attemptLeaf(r: LeafInput): string {
  if (typeof r.ts !== "string" || !ISO_MS.test(r.ts)) throw new Error("leaf ts must be ISO-8601 UTC with milliseconds, like 2026-11-02T12:34:56.789Z");
  const text = JSON.stringify([r.id, r.ts, r.tier, r.account_hash, r.message, leafOutcome(r.outcome), r.prompt_sha256, r.model_id, r.attestation_sha256, r.codehash]);
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
