import { proxy } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
// The id goes into the agent path as one segment; the agent checks it is a ULID.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxy(req, `/attempt/${encodeURIComponent(id)}`);
}
