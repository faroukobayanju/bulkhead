import { v } from "convex/values";
import { MAX_MESSAGE, STAGES, TRANSITIONS } from "../shared/attempt";
import { publicAttempt } from "./lib/public";
import { addCounter, fail, HEX64, internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./lib/server";
import { attemptFields, outcome, stage, tier } from "./lib/validators";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Outcomes a row can be inserted with. A payout outcome other than `releasing` is only ever reached by `finish`.
const INSERT_OUTCOMES = ["refused", "blocked_a", "blocked_b", "tool_error", "releasing", "won_race_lost"];
const REPORTS_TO_HIDE = 3;

const byId = (ctx: QueryCtx | MutationCtx, id: string) => ctx.db.query("attempts").withIndex("by_attempt_id", q => q.eq("id", id)).first();

// Shape the validators cannot express. Messages name the field and never repeat a value.
function check(a: { id: string; ts: string; account_hash: string; ip_hash: string; leaf: string; message: string; reply: string; consent_version: string; payout_address: string; outcome: string; near_tx: string | null; chain_txid: string | null }) {
  const bad = (field: string, why: string) => fail("bad_request", `${field}: ${why}`);
  if (!ULID.test(a.id)) bad("id", "not a ULID");
  if (!ISO_MS.test(a.ts) || new Date(a.ts).toISOString() !== a.ts) bad("ts", "not ISO-8601 UTC with milliseconds");
  for (const k of ["account_hash", "ip_hash", "leaf"] as const) if (!HEX64.test(a[k])) bad(k, "not a lowercase sha256 hex");
  if (a.message.length > MAX_MESSAGE) bad("message", `over ${MAX_MESSAGE} characters`);
  if (!a.consent_version) bad("consent_version", "empty");
  if (a.reply.length > 8000) bad("reply", "over 8000 characters");
  if (!a.payout_address || a.payout_address.length > 128) bad("payout_address", "empty or over 128 characters");
  if (!INSERT_OUTCOMES.includes(a.outcome)) bad("outcome", "cannot be inserted");
  for (const k of ["near_tx", "chain_txid"] as const) if (a[k] !== null && a[k]!.length > 256) bad(k, "over 256 characters");
}

export const insert = internalMutation({
  args: attemptFields,
  handler: async (ctx, a) => {
    check(a);
    for (const k of ["signature", "signer"] as const) if (a[k] !== undefined && (a[k].length === 0 || a[k].length > 512)) fail("bad_request", `${k}: empty or over 512 characters`);
    if (await byId(ctx, a.id)) fail("conflict", "id exists");
    await ctx.db.insert("attempts", { ...a, hidden: false });
    // in this transaction: either the row and its counts are written, or none of them
    await addCounter(ctx, `attempts:tier:${a.tier}`, 1);
    if (a.outcome === "blocked_b") await addCounter(ctx, `nearmiss:tier:${a.tier}`, 1);
    return null;
  },
});

// The one change to a row after insert: what the release did (or what the rebroadcast loop settled). Nothing else can be edited.
export const finish = internalMutation({
  args: { id: v.string(), outcome, reply: v.optional(v.string()), near_tx: v.optional(v.string()), chain_txid: v.optional(v.string()), signature: v.optional(v.string()), signer: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const row = await byId(ctx, a.id);
    if (!row) return fail("not_found", "attempt");
    if (!TRANSITIONS[row.outcome]?.includes(a.outcome)) return fail("bad_transition", `${row.outcome} to ${a.outcome}`);
    for (const k of ["reply", "near_tx", "chain_txid"] as const) if (a[k] !== undefined && a[k].length > (k === "reply" ? 8000 : 256)) fail("bad_request", `${k}: too long`);
    await ctx.db.patch(row._id, {
      outcome: a.outcome,
      stage: "done",
      ...(a.reply !== undefined && { reply: a.reply }),
      ...(a.near_tx !== undefined && { near_tx: a.near_tx }),
      ...(a.chain_txid !== undefined && { chain_txid: a.chain_txid }),
      ...(a.signature !== undefined && { signature: a.signature }),
      ...(a.signer !== undefined && { signer: a.signer }),
    });
    return null;
  },
});

// Written before the release call is sent. Only a `releasing` row takes it, and only once (the same values again are a no-op).
export const markSent = internalMutation({
  args: { id: v.string(), release_tx: v.string(), release_ref_height: v.number() },
  handler: async (ctx, a) => {
    const row = await byId(ctx, a.id);
    if (!row) return fail("not_found", "attempt");
    if (row.outcome !== "releasing") return fail("bad_transition", `${row.outcome} cannot take a release tx`);
    if (a.release_tx.length > 64 || !Number.isInteger(a.release_ref_height) || a.release_ref_height < 0) fail("bad_request", "release_tx or release_ref_height");
    if (row.release_tx !== undefined && row.release_tx !== a.release_tx) return fail("conflict", "release_tx already set");
    await ctx.db.patch(row._id, { release_tx: a.release_tx, release_ref_height: a.release_ref_height });
    return null;
  },
});

// The payout work list (agent only): rows still `releasing` or `signed_pending_broadcast`, plus `drained` rows since `drained_since`
// (their spent coins and nonces must not be picked again before they confirm). Needed fields only, each outcome bounded.
const PAYOUT_TAKE = 200;
export const payouts = internalQuery({
  args: { drained_since: v.string() },
  handler: async (ctx, a) => {
    const rows = [
      ...(await ctx.db.query("attempts").withIndex("by_outcome_ts", q => q.eq("outcome", "releasing")).order("desc").take(PAYOUT_TAKE)),
      ...(await ctx.db.query("attempts").withIndex("by_outcome_ts", q => q.eq("outcome", "signed_pending_broadcast")).order("desc").take(PAYOUT_TAKE)),
      ...(await ctx.db.query("attempts").withIndex("by_outcome_ts", q => q.eq("outcome", "drained").gte("ts", a.drained_since)).order("desc").take(PAYOUT_TAKE)),
    ];
    return rows.map(r => ({ id: r.id, tier: r.tier, outcome: r.outcome, ts: r.ts, near_tx: r.near_tx, release_tx: r.release_tx ?? null, release_ref_height: r.release_ref_height ?? null }));
  },
});

// The whole stored row (agent only), so the agent can sign the row as it will read after an update.
export const getFull = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, a) => {
    const row = await byId(ctx, a.id);
    if (!row) return null;
    const { _id, _creationTime, ...rest } = row;
    return rest;
  },
});

// Forward only, so an update that arrives late cannot undo `done`. false: nothing changed (no row yet, or not forward).
export const setStage = internalMutation({
  args: { id: v.string(), stage },
  handler: async (ctx, a) => {
    const row = await byId(ctx, a.id);
    if (!row || STAGES.indexOf(a.stage) <= STAGES.indexOf(row.stage)) return false;
    await ctx.db.patch(row._id, { stage: a.stage });
    return true;
  },
});

// A report by an account counts once. The third distinct account hides the row from the public queries; the dataset keeps it.
export const report = internalMutation({
  args: { attempt_id: v.string(), account_hash: v.string() },
  handler: async (ctx, a) => {
    if (!HEX64.test(a.account_hash)) fail("bad_request", "account_hash: not a lowercase sha256 hex");
    const row = await byId(ctx, a.attempt_id);
    if (!row) return fail("not_found", "attempt");
    const mine = await ctx.db.query("reports").withIndex("by_attempt_account", q => q.eq("attempt_id", a.attempt_id).eq("account_hash", a.account_hash)).first();
    if (!mine) await ctx.db.insert("reports", { attempt_id: a.attempt_id, account_hash: a.account_hash, ts: new Date().toISOString() });
    const n = (await ctx.db.query("reports").withIndex("by_attempt_account", q => q.eq("attempt_id", a.attempt_id)).take(REPORTS_TO_HIDE)).length;
    const hidden = row.hidden || n >= REPORTS_TO_HIDE;
    if (hidden && !row.hidden) await ctx.db.patch(row._id, { hidden: true });
    return { hidden };
  },
});

// For the dataset export (agent only): every column, hidden rows included, in ts order from `since`.
export const exportPage = internalQuery({
  args: { since: v.string(), cursor: v.union(v.string(), v.null()), limit: v.number() },
  handler: async (ctx, a) => {
    if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 1000) fail("bad_request", "limit: 1 to 1000");
    const page = await ctx.db.query("attempts").withIndex("by_ts", q => q.gte("ts", a.since)).order("asc").paginate({ numItems: a.limit, cursor: a.cursor });
    return { rows: page.page.map(({ _id, _creationTime, ...row }) => row), next: page.continueCursor, done: page.isDone };
  },
});

const limitOf = (n: number | undefined, dflt: number) => {
  const limit = n ?? dflt;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("bad_request", "limit: 1 to 50");
  return limit;
};

// Public. A hidden row is not found.
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, a) => {
    const row = await byId(ctx, a.id);
    return row && !row.hidden ? publicAttempt(row) : null;
  },
});

export const recent = query({
  args: { tier: v.optional(tier), limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const limit = limitOf(a.limit, 20);
    const rows =
      a.tier === undefined
        ? await ctx.db.query("attempts").withIndex("by_hidden_ts", q => q.eq("hidden", false)).order("desc").take(limit)
        : await ctx.db.query("attempts").withIndex("by_hidden_tier_ts", q => q.eq("hidden", false).eq("tier", a.tier!)).order("desc").take(limit);
    return rows.map(publicAttempt);
  },
});

// The agent agreed and the firewall stopped it.
export const nearMisses = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("attempts").withIndex("by_hidden_outcome_ts", q => q.eq("hidden", false).eq("outcome", "blocked_b")).order("desc").take(limitOf(a.limit, 10));
    return rows.map(publicAttempt);
  },
});
