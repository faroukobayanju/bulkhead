import { loadArena } from "@/lib/arena";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await loadArena(), { headers: { "cache-control": "no-store" } });
}
