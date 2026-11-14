// E17 plumbing: which model completions belong to which attempt. The attempt runs inside withCompletions; the NEAR AI client's
// onCompletion hook (trackCompletion) starts a signature check for each answered call without waiting for it, so the judge's 3.5 s
// budget is untouched. Just before the row is written, responseVerified() waits a short while for the checks. A check that has not
// finished, failed, or never started counts as false: nothing is called verified without a result.
import { AsyncLocalStorage } from "node:async_hooks";
import type { CompletionInfo } from "./nearai";

const als = new AsyncLocalStorage<{ pending: Promise<boolean>[] }>();

export const withCompletions = <T>(fn: () => Promise<T>) => als.run({ pending: [] }, fn);

export function trackCompletion(verify: (c: CompletionInfo) => Promise<boolean>): (c: CompletionInfo) => void {
  return c => {
    const store = als.getStore();
    if (store) store.pending.push(verify(c).then(v => v === true, () => false));
  };
}

// true only when at least one call was made in this attempt and every one verified within waitMs.
export async function responseVerified(waitMs = 2000): Promise<boolean> {
  const store = als.getStore();
  if (!store || store.pending.length === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean[]>(r => (timer = setTimeout(() => r([false]), waitMs)));
  try {
    return (await Promise.race([Promise.all(store.pending), timeout])).every(Boolean);
  } finally {
    clearTimeout(timer);
  }
}
