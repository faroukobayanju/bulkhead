// Daily counters for the firewall budgets and the NEAR AI spend cap.
// ponytail: in-memory, single agent instance. A restart resets every count, so a restart can hand out a day's budget twice;
// Task 8 injects Convex counters (same interface) before launch. Keys of past days stay in the map until restart.
export type Counter = {
  get(key: string): Promise<number>;
  // Add n and return the new total. With `cap`, adds nothing and returns null when the new total would pass it.
  add(key: string, n: number, cap?: number): Promise<number | null>;
};

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function memoryCounter(): Counter {
  const totals = new Map<string, number>();
  return {
    async get(key) {
      return totals.get(key) ?? 0;
    },
    async add(key, n, cap) {
      const next = (totals.get(key) ?? 0) + n;
      if (cap !== undefined && next > cap) return null;
      totals.set(key, next);
      return next;
    },
  };
}
