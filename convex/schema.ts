// E20: the six tables. Every write comes from the agent through the HTTP action in http.ts, and the public queries return allowlists.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { attemptFields, oneOf, verdict } from "./lib/validators";

export default defineSchema({
  attempts: defineTable({ ...attemptFields, hidden: v.boolean() })
    .index("by_attempt_id", ["id"])
    .index("by_ts", ["ts"]) // dataset export
    .index("by_tier_ts", ["tier", "ts"])
    .index("by_account_tier_ts", ["account_hash", "tier", "ts"])
    // the public queries: visible rows only, newest first
    .index("by_hidden_ts", ["hidden", "ts"])
    .index("by_hidden_tier_ts", ["hidden", "tier", "ts"])
    .index("by_hidden_outcome_ts", ["hidden", "outcome", "ts"])
    .index("by_outcome_ts", ["outcome", "ts"]), // the payout work list: no scans
  replays: defineTable({ attempt_id: v.string(), fw_version: v.string(), verdict, risk: v.number(), ts: v.string() }).index("by_attempt_version", ["attempt_id", "fw_version"]),
  api_keys: defineTable({ key_hash: v.string(), created: v.string(), label: v.optional(v.string()) }).index("by_key_hash", ["key_hash"]),
  signed_txs: defineTable({ attempt_id: v.string(), chain: oneOf(["btc", "evm"]), hex: v.string() }).index("by_attempt", ["attempt_id"]),
  reports: defineTable({ attempt_id: v.string(), account_hash: v.string(), ts: v.string() }).index("by_attempt_account", ["attempt_id", "account_hash"]),
  counters: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]),
});
