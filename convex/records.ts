// The smaller agent-only records: replays, API keys, signed transactions, and the health check.
import { v } from "convex/values";
import { fail, HEX64, internalMutation, internalQuery } from "./lib/server";
import { oneOf, verdict } from "./lib/validators";

const now = () => new Date().toISOString();
const HEX = /^(?:[0-9a-f]{2})+$/i;
const MAX_TX_HEX = 20_000;

export const ping = internalQuery({
  args: {},
  handler: async ctx => {
    await ctx.db.query("counters").first();
    return true;
  },
});

// The first verdict for an attempt and firewall version stands: a judge call is not reproducible, so the one issued is the record.
export const putReplay = internalMutation({
  args: { attempt_id: v.string(), fw_version: v.string(), verdict, risk: v.number() },
  handler: async (ctx, a) => {
    if (!Number.isInteger(a.risk) || a.risk < 0 || a.risk > 100) fail("bad_request", "risk: integer 0 to 100");
    const had = await ctx.db.query("replays").withIndex("by_attempt_version", q => q.eq("attempt_id", a.attempt_id).eq("fw_version", a.fw_version)).first();
    if (had) return false;
    await ctx.db.insert("replays", { ...a, ts: now() });
    return true;
  },
});

// Only a sha256 of a key is ever stored or looked up.
const keyHash = (h: string) => (HEX64.test(h) ? h : fail("bad_request", "key_hash: not a lowercase sha256 hex"));

export const keyExists = internalQuery({
  args: { key_hash: v.string() },
  handler: async (ctx, a) => !!(await ctx.db.query("api_keys").withIndex("by_key_hash", q => q.eq("key_hash", keyHash(a.key_hash))).first()),
});

export const putKey = internalMutation({
  args: { key_hash: v.string(), label: v.optional(v.string()) },
  handler: async (ctx, a) => {
    keyHash(a.key_hash);
    if (a.label !== undefined && a.label.length > 100) fail("bad_request", "label: over 100 characters");
    if (await ctx.db.query("api_keys").withIndex("by_key_hash", q => q.eq("key_hash", a.key_hash)).first()) return false;
    await ctx.db.insert("api_keys", { key_hash: a.key_hash, created: now(), ...(a.label !== undefined && { label: a.label }) });
    return true;
  },
});

// E6: the fully signed transaction, stored when the agent first has it, so a payout can be rebroadcast after a restart. It is never
// overwritten: a second, different hex for the same attempt is a conflict. The attempt's row must exist (persist first).
export const putSignedTx = internalMutation({
  args: { attempt_id: v.string(), chain: oneOf(["btc", "evm"]), hex: v.string() },
  handler: async (ctx, a) => {
    if (!HEX.test(a.hex) || a.hex.length > MAX_TX_HEX) fail("bad_request", "hex: not even-length hex up to 20000 characters");
    if (!(await ctx.db.query("attempts").withIndex("by_attempt_id", q => q.eq("id", a.attempt_id)).first())) fail("not_found", "attempt");
    const had = await ctx.db.query("signed_txs").withIndex("by_attempt", q => q.eq("attempt_id", a.attempt_id)).first();
    if (had) return had.hex === a.hex && had.chain === a.chain ? false : fail("conflict", "a different transaction is stored");
    await ctx.db.insert("signed_txs", a);
    return true;
  },
});

export const getSignedTx = internalQuery({
  args: { attempt_id: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("signed_txs").withIndex("by_attempt", q => q.eq("attempt_id", a.attempt_id)).first();
    return row ? { chain: row.chain, hex: row.hex } : null;
  },
});
