// The day's attempt roots on-chain at 00:10 UTC, posted with the agent's own vault key (in the TEE the only key there is). The same
// build and post as scripts/export-dataset.ts, which then only writes the files.
import { postRoots, type buildDay, type RootsVault } from "../../scripts/export-dataset";
import { isoMs } from "../../shared/leaf";
import { epochDay } from "../../shared/merkle";

const DAY_MS = 86_400_000;
const RUN_AT_MS = 10 * 60_000; // 00:10 UTC: the export refuses a day until 5 minutes after it ends

export function startRootsPoster(o: {
  build: (date: string) => ReturnType<typeof buildDay>;
  vault: RootsVault;
  log: (event: string, data: Record<string, unknown>) => void;
  alert: (kind: string, details: Record<string, unknown>) => void;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  retryMs?: number;
}): () => void {
  const clock = o.clock ?? Date.now;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>));
  const retryMs = o.retryMs ?? 3_600_000;
  let timer: unknown;
  let stopped = false;
  const after = (fn: () => void, ms: number) => void (stopped || (timer = setTimer(fn, ms)));
  const untilNext = () => {
    const now = clock();
    const next = Math.floor(now / DAY_MS) * DAY_MS + RUN_AT_MS;
    return (next > now ? next : next + DAY_MS) - now;
  };
  const daily = () => run(isoMs(clock() - DAY_MS).slice(0, 10)); // yesterday
  const run = async (date: string) => {
    try {
      const b = await o.build(date);
      if (!b.ok) throw new Error(b.reason);
      if (b.roots.length) {
        const r = await postRoots(o.vault, epochDay(date), b.roots);
        if (r === "differ") {
          // retrying cannot fix this: someone else's roots hold the day
          o.log("roots_mismatch", { date });
          o.alert("roots_mismatch", { date });
        } else o.log("roots_posted", { date, hours: b.roots.length, already: r === "already" });
      }
      after(daily, untilNext());
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      o.log("roots_post_failed", { date, error });
      o.alert("roots_post_failed", { date, error });
      after(() => run(date), retryMs);
    }
  };
  // A restart after 00:10 would otherwise skip yesterday until tomorrow's run, which posts a different day. Posting is
  // idempotent, so catch up at once; before 00:10 yesterday may not be over plus grace, so wait for the normal run.
  after(daily, clock() % DAY_MS >= RUN_AT_MS ? 0 : untilNext());
  return () => {
    stopped = true;
    clearTimer(timer);
  };
}
