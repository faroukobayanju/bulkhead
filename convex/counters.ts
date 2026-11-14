// The Counter of agent/src/counter.ts, in Convex. One mutation is one transaction, so a capped add (check, then add) is atomic:
// a call that would pass the cap adds nothing. Spend, the firewall budgets, attempts per tier and near misses all live here.
import { v } from "convex/values";
import { addCounter, fail, internalMutation, internalQuery, query } from "./lib/server";

const checkKey = (key: string) => key.length >= 1 && key.length <= 200;

export const add = internalMutation({
  args: { key: v.string(), n: v.number(), cap: v.optional(v.number()) },
  handler: async (ctx, a) => {
    if (!checkKey(a.key)) fail("bad_request", "key: 1 to 200 characters");
    if (!Number.isFinite(a.n) || (a.cap !== undefined && !Number.isFinite(a.cap))) fail("bad_request", "n and cap must be finite");
    return await addCounter(ctx, a.key, a.n, a.cap);
  },
});

export const get = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, a) => {
    if (!checkKey(a.key)) fail("bad_request", "key: 1 to 200 characters");
    return (await ctx.db.query("counters").withIndex("by_key", q => q.eq("key", a.key)).unique())?.value ?? 0;
  },
});

// Public: attempts and near misses per tier, read from counters. No query scans the attempts.
export const tiers = query({
  args: {},
  handler: async ctx => {
    const read = async (key: string) => (await ctx.db.query("counters").withIndex("by_key", q => q.eq("key", key)).unique())?.value ?? 0;
    return await Promise.all(([1, 2, 3] as const).map(async tier => ({ tier, attempts: await read(`attempts:tier:${tier}`), nearMisses: await read(`nearmiss:tier:${tier}`) })));
  },
});
