// Kamui: the one rate limiter every route uses. The interface is asynchronous so that a shared
// store (Redis, a database) can replace the in-process implementation when the api is
// replicated: implement `take` as one atomic operation there and pass it in the context.
export interface Limiter {
  /**
   * Records a hit for `key` and returns true when there were fewer than `limit` hits in the
   * last `windowMs`. Returns false, and records nothing, when the limit is reached.
   */
  take(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/** Sliding window, in this process. Counts are lost on restart and not shared between replicas. */
export class MemoryLimiter implements Limiter {
  private hits = new Map<string, { times: number[]; windowMs: number }>();

  /** `maxKeys` bounds memory: beyond it, expired keys are swept and then the oldest are dropped. */
  constructor(private now: () => number = Date.now, private maxKeys = 100_000) {}

  async take(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = this.now();
    const times = (this.hits.get(key)?.times ?? []).filter((t) => now - t < windowMs);
    const allowed = times.length < limit;
    if (allowed) times.push(now);
    // Re-inserting moves the key to the end, so the map stays ordered by last use.
    this.hits.delete(key);
    if (times.length) this.hits.set(key, { times, windowMs });
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return allowed;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) {
      if (!entry.times.some((t) => now - t < entry.windowMs)) this.hits.delete(key);
    }
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
