// ponytail: in-memory windows, single agent instance; move to Postgres if the CVM ever runs >1 replica
type Key = { account: string; ip: string; tier: 1 | 2 | 3 };
type RuleName = "account" | "ip" | "tier";
export type RateResult = { ok: true } | { ok: false; retryAfterS: number; rule: RuleName };

const RULES = [
  { name: "account", windowMs: 600_000, max: 1, key: (k: Key) => `a:${k.account}:${k.tier}` },
  { name: "ip", windowMs: 3_600_000, max: 20, key: (k: Key) => `i:${k.ip}` },
  { name: "tier", windowMs: 3_600_000, max: 120, key: (k: Key) => `t:${k.tier}` },
] as const;
const LONGEST_MS = 3_600_000;
const SWEEP_MS = 60_000;

const validScale = (n: number) => n > 0 && n <= 1;

// RATE_LIMIT_SCALE shortens every window (0.01 = 100x) so a demo can run on testnet; it must never reach mainnet.
export function rateLimitScale(env: Record<string, string | undefined>): number {
  const raw = env.RATE_LIMIT_SCALE;
  if (raw === undefined) return 1;
  if (env.NEAR_NETWORK !== "testnet") throw new Error("RATE_LIMIT_SCALE is only allowed when NEAR_NETWORK=testnet");
  const n = Number(raw);
  if (!validScale(n)) throw new Error(`RATE_LIMIT_SCALE must be a number in (0, 1], got "${raw}"`);
  return n;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private sweepAt = 0;

  // a scale of 0 or NaN would make every window empty and silently turn the limiter off
  constructor(private scale = 1) {
    if (!validScale(scale)) throw new Error(`rate limit scale must be in (0, 1], got ${scale}`);
  }

  get size() {
    return this.hits.size;
  }

  check(k: Key, now: number): RateResult {
    this.sweep(now);
    let wait = 0;
    let rule: RuleName | undefined;
    const live: number[][] = [];
    for (const r of RULES) {
      const windowMs = r.windowMs * this.scale;
      const hits = (this.hits.get(r.key(k)) ?? []).filter(t => t > now - windowMs);
      live.push(hits);
      if (hits.length >= r.max) {
        const s = Math.ceil((Math.min(...hits) + windowMs - now) / 1000);
        if (s > wait) [wait, rule] = [s, r.name];
      }
    }
    // a rejected check records nothing, so it cannot eat the budget of the other windows
    RULES.forEach((r, i) => this.put(r.key(k), rule ? live[i] : [...live[i], now]));
    return rule ? { ok: false, retryAfterS: wait, rule } : { ok: true };
  }

  // Undo the hit a successful check recorded. Hits are bare timestamps and the ip and tier windows are
  // shared, so the account window finds the hit and each window then drops one entry carrying its timestamp.
  refund(k: Key, now: number): void {
    const [account] = RULES;
    const mine = (this.hits.get(account.key(k)) ?? []).filter(t => t > now - account.windowMs * this.scale);
    if (!mine.length) return;
    const t = Math.max(...mine);
    for (const r of RULES) {
      const id = r.key(k);
      const hits = this.hits.get(id) ?? [];
      const i = hits.lastIndexOf(t);
      if (i >= 0) hits.splice(i, 1);
      this.put(id, hits);
    }
  }

  private put(id: string, hits: number[]) {
    if (hits.length) this.hits.set(id, hits);
    else this.hits.delete(id);
  }

  // Keys nobody touches again would sit here forever; sweep at most once a minute (scaled).
  private sweep(now: number) {
    if (now < this.sweepAt) return;
    this.sweepAt = now + SWEEP_MS * this.scale;
    const cutoff = now - LONGEST_MS * this.scale;
    for (const [id, hits] of this.hits) if (hits.every(t => t <= cutoff)) this.hits.delete(id);
  }
}
