// Test helper: tracks timers set with one distinctive delay, so a test can prove none is left pending.
export function trackTimers(delay: number) {
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
    const t: unknown = set(() => (live.delete(t), fn()), ms, ...a);
    if (ms === delay) live.add(t);
    return t;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((t: unknown) => (live.delete(t), clear(t as never))) as typeof clearTimeout;
  return {
    live,
    restore() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}
