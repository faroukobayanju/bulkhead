// The window key for a client address. IPv4 is per address. IPv6 is per /64: one subscriber holds a whole /64 and could
// otherwise rotate through it. An IPv4-mapped IPv6 address is that IPv4 address. `ip` must already pass isIP.
export function ipKey(ip: string): string {
  let s = ip.toLowerCase().split("%")[0]!; // a zone id is not part of the address
  if (!s.includes(":")) return s;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); // embedded IPv4 tail becomes two hex groups
  if (v4) s = `${s.slice(0, v4.index)}${((+v4[1]! << 8) | +v4[2]!).toString(16)}:${((+v4[3]! << 8) | +v4[4]!).toString(16)}`;
  const [head = "", rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = rest ? rest.split(":") : [];
  const g = (rest === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t]).map(x => x.padStart(4, "0"));
  if (g.slice(0, 5).every(x => x === "0000") && g[5] === "ffff") {
    const [a, b] = [parseInt(g[6]!, 16), parseInt(g[7]!, 16)];
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `${g.slice(0, 4).join(":")}::/64`;
}

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
