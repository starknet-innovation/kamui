/**
 * Token buckets in process memory. Enough for one instance; several instances need a shared
 * store or a limit at the edge (DESIGN.md, section 4).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private burst: number,
    private perMs: number,
    private now: () => number,
    private maxKeys = 100_000,
  ) {}

  /** Takes one token for `key`. False when the bucket is empty. */
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * this.perMs);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) this.prune(t);
    this.buckets.set(key, b);
    return ok;
  }

  /** Drops buckets that have refilled; if still full, drops everything rather than grow without bound. */
  private prune(t: number) {
    for (const [k, b] of this.buckets) if (b.tokens + (t - b.at) * this.perMs >= this.burst) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
