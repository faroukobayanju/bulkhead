import { notFound } from "next/navigation";
import { TierView } from "@/components/TierView";
import { loadArena } from "@/lib/arena";
import { TIER_INFO } from "@/lib/tiers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const info = TIER_INFO[Number(id) as 1 | 2 | 3];
  return { title: info ? `Tier ${id}, ${info.name}` : "Tier" };
}

export default async function TierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!["1", "2", "3"].includes(id)) notFound();
  return <TierView initial={await loadArena()} tier={Number(id) as 1 | 2 | 3} />;
}
