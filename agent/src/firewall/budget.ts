// Daily call budgets for the judge, in three pools that never draw on each other (E10).
// ponytail: counts live in the injected Counter; with the in-memory one a restart resets them (see counter.ts).
import type { Counter } from "../counter";
import { utcDay } from "../counter";

export const LIMITS = { apiKey: 300, apiGlobal: 2000, playground: 300, arena: 3000 };

export function makeBudget(o: { counter: Counter; clock: () => number; limits?: Partial<typeof LIMITS> }) {
  const limit = { ...LIMITS, ...o.limits };
  const take = async (key: string, cap: number, day: string) => (await o.counter.add(`fw:${key}:${day}`, 1, cap)) !== null;
  return {
    // `keyId` is a hash of the API key, never the key. A call over the key's quota never reaches the global pool, and one
    // the global pool refuses is taken back off the key.
    async chargeApi(keyId: string) {
      const day = utcDay(o.clock());
      if (!(await take(`key:${keyId}`, limit.apiKey, day))) return false;
      if (await take("api", limit.apiGlobal, day)) return true;
      await o.counter.add(`fw:key:${keyId}:${day}`, -1);
      return false;
    },
    chargePlayground: () => take("playground", limit.playground, utcDay(o.clock())),
    // Tier-3 checkpoints and replay share this pool; Task 8 calls it before checkFirewall.
    chargeArena: () => take("arena", limit.arena, utcDay(o.clock())),
  };
}
export type Budget = ReturnType<typeof makeBudget>;
