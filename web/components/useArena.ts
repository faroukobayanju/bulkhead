"use client";
// The arena as the server first rendered it, refreshed from /api/arena every 30 s. A failed refresh, or a pot that failed to read,
// keeps the last good pot and marks it stale (lib/tiers.ts mergePot), so a pot is never shown blank or as zero by mistake.
import { useEffect, useState } from "react";
import type { Arena } from "@/lib/arena";
import { mergePot, type PotState } from "@/lib/tiers";

export const REFRESH_MS = 30_000;
type Pots = Record<number, PotState>;
const potsOf = (a: Arena, prev: Pots = {}): Pots => Object.fromEntries(a.tiers.map(t => [t.id, mergePot(prev[t.id], t.pot, a.at)]));

export function useArena(initial: Arena) {
  const [arena, setArena] = useState(initial);
  const [pots, setPots] = useState<Pots>(() => potsOf(initial));
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/arena", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const a: Arena = await r.json();
        setArena(a);
        setPots(p => potsOf(a, p));
      } catch {
        setPots(p => Object.fromEntries(Object.entries(p).map(([k, s]) => [k, mergePot(s, null, new Date().toISOString())])));
      }
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  return { arena, pots };
}
