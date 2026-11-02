// Sliding-window hit counter for the per-minute limits.
// ponytail: in-memory, single agent instance; a restart forgets the window.
export class SlidingWindow {
  private hits = new Map<string, number[]>();
  private sweepAt = 0;

  constructor(private windowMs = 60_000) {}

  get size() {
    return this.hits.size;
  }

  // 0 when the hit is allowed (and recorded); otherwise whole seconds until the oldest hit leaves the window.
  // A refused hit records nothing.
  hit(id: string, max: number, now: number): number {
    this.sweep(now);
    const live = (this.hits.get(id) ?? []).filter(t => t > now - this.windowMs);
    if (live.length >= max) {
      this.hits.set(id, live);
      return Math.max(1, Math.ceil((Math.min(...live) + this.windowMs - now) / 1000));
    }
    this.hits.set(id, [...live, now]);
    return 0;
  }

  // Ids nobody touches again would sit here forever (playground IPs); sweep at most once a window.
  private sweep(now: number) {
    if (now < this.sweepAt) return;
    this.sweepAt = now + this.windowMs;
    for (const [id, hits] of this.hits) if (hits.every(t => t <= now - this.windowMs)) this.hits.delete(id);
  }
}
