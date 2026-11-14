"use client";
// Convex in the browser (E20): public queries only, through useQuery, so the page updates when the agent writes. With no
// NEXT_PUBLIC_CONVEX_URL (or MOCK_AGENT=1, where the server passes fixtures) nothing here runs.
import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { anyApi } from "convex/server";
import { useEffect } from "react";
import type { PublicData } from "@/lib/public-data";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;
export const convexLive = client !== null;

export function ConvexRoot({ children }: { children: React.ReactNode }) {
  return client ? <ConvexProvider client={client}>{children}</ConvexProvider> : <>{children}</>;
}

// The home page's public data, live. `initial` (the server's read) shows until the subscription answers.
export function LivePublic({ initial, children }: { initial: PublicData; children: (d: PublicData) => React.ReactNode }) {
  const counters = useQuery(anyApi.counters!.tiers!, {});
  const winners = useQuery(anyApi.attempts!.winners!, {});
  const nearMisses = useQuery(anyApi.attempts!.nearMisses!, {});
  return <>{children({ counters: counters ?? initial.counters, winners: winners ?? initial.winners, nearMisses: nearMisses ?? initial.nearMisses, pendingBroadcasts: initial.pendingBroadcasts })}</>;
}

// The stage the agent last wrote on the attempt row. The row exists only from the payout step on (or at the end), so the tier
// page also polls GET /attempt/:id; this makes signing and broadcasting show the moment they land.
export function LiveStage({ id, onStage }: { id: string; onStage: (stage: string) => void }) {
  const stage: string | undefined = useQuery(anyApi.attempts!.get!, { id })?.stage;
  useEffect(() => {
    if (stage) onStage(stage);
  }, [stage, onStage]);
  return null;
}
