"use client";
import { useEffect, useState } from "react";
import { clock } from "@/lib/outcome";

// Counts down to `until` (ms since epoch) and renders `template` with {t} replaced. Shows 0:00 at the end, never negative.
export function Countdown({ until, template = "{t}" }: { until: number; template?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="mono" suppressHydrationWarning>{template.replace("{t}", clock((until - now) / 1000))}</span>;
}
