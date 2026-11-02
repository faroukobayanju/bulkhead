// Builders typed against the schema without codegen (no `convex dev`, no _generated). There is deliberately no public mutation
// builder: every write is an internal mutation reached through the HTTP action, which checks the agent secret.
import { internalMutationGeneric, internalQueryGeneric, queryGeneric, type DataModelFromSchemaDefinition, type GenericMutationCtx, type GenericQueryCtx, type MutationBuilder, type QueryBuilder } from "convex/server";
import { ConvexError } from "convex/values";
import type schema from "../schema";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type QueryCtx = GenericQueryCtx<DataModel>;
export const query = queryGeneric as QueryBuilder<DataModel, "public">;
export const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
export const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;

// What http.ts turns into a status: bad_request 400, not_found 404, conflict and bad_transition 409. `detail` names a field or
// a state, never a value from the request.
export const fail = (code: string, detail?: string): never => {
  throw new ConvexError({ code, detail });
};

export const HEX64 = /^[0-9a-f]{64}$/;

// Add `n` to a counter. With `cap`, adds nothing and returns null when the total would pass it. counters.ts and the attempt insert
// share this; a mutation is one transaction, so the check and the add cannot be split by another call.
export async function addCounter(ctx: MutationCtx, key: string, n: number, cap?: number): Promise<number | null> {
  const row = await ctx.db.query("counters").withIndex("by_key", q => q.eq("key", key)).unique();
  const next = (row?.value ?? 0) + n;
  if (!Number.isFinite(next)) fail("bad_request", "total is not finite");
  if (cap !== undefined && next > cap) return null;
  if (row) await ctx.db.patch(row._id, { value: next });
  else await ctx.db.insert("counters", { key, value: next });
  return next;
}
