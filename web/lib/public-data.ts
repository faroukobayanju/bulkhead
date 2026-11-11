// Public Convex reads (E20). Pages that need live updates subscribe with useQuery in the browser (components/Live.tsx); this file
// is the one-off server read for /verify and /dataset, and the fixture source for MOCK_AGENT=1. Only public queries, no secret.
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import fixture from "../fixtures/public.json";
import { isMock } from "./arena";

export type PublicAttempt = {
  id: string; ts: string; tier: 1 | 2 | 3; outcome: string; message: string; reply: string; technique: string | null; tool_called: boolean;
  fw_a: { verdict: string; risk: number; technique: string } | null; fw_b: { verdict: string; risk: number; technique: string } | null;
  near_tx: string | null; chain_txid: string | null; payout: string | null;
};
export type Counter = { tier: 1 | 2 | 3; attempts: number; nearMisses: number };
export type PendingBroadcast = { id: string; tier: 1 | 2 | 3; ts: string; near_tx: string | null; chain: "btc" | "evm" | null; hex: string | null };
export type PublicData = { counters: Counter[] | null; winners: PublicAttempt[] | null; nearMisses: PublicAttempt[] | null; pendingBroadcasts: PendingBroadcast[] | null };

export const mockPublic = () => fixture as unknown as PublicData;

export async function loadPublic(): Promise<PublicData> {
  if (isMock()) return mockPublic();
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return { counters: null, winners: null, nearMisses: null, pendingBroadcasts: null };
  const c = new ConvexHttpClient(url);
  const q = <R,>(p: Promise<R>) => p.catch(() => null);
  const [counters, winners, nearMisses, pendingBroadcasts] = await Promise.all([
    q(c.query(anyApi.counters!.tiers!, {})),
    q(c.query(anyApi.attempts!.winners!, {})),
    q(c.query(anyApi.attempts!.nearMisses!, {})),
    q(c.query(anyApi.attempts!.pendingBroadcasts!, {})),
  ]);
  return { counters, winners, nearMisses, pendingBroadcasts } as PublicData;
}
