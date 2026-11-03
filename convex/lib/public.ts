// What a browser may see of an attempt: an explicit list of fields, built one by one, never a spread of the stored row.
// Not here, on purpose: ip_hash, account_hash, hidden, llm_output, normalized, payout_address, the hashes and codehash, and the
// firewall `reason` (the next day's dataset publishes full reasons). A new column stays private until it is added below.
import type { DocumentByName } from "convex/server";
import type { DataModel } from "./server";
import { attemptView } from "../../shared/attempt-view";

type Attempt = DocumentByName<DataModel, "attempts">;

// The shared view (what the agent signs) plus stage, and the signature that goes with it. Old rows have none: null.
export const publicAttempt = (d: Attempt) => ({
  ...attemptView(d),
  stage: d.stage,
  signature: d.signature ?? null,
  signer: d.signer ?? null,
});
