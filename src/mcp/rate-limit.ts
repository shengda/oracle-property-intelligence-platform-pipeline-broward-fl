/** Fixed-window per-key limiter (per IP). In-memory: one window per server/Lambda instance. */
export interface RateLimiter {
  allow(key: string): boolean;
}

export function createRateLimiter(opts: {
  limit: number;
  windowMs?: number;
  now?: () => number;
}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { start: number; n: number }>();
  return {
    allow(key) {
      const t = now();
      const h = hits.get(key);
      if (!h || t - h.start >= windowMs) {
        hits.set(key, { start: t, n: 1 });
        if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
        return true;
      }
      h.n++;
      return h.n <= opts.limit;
    },
  };
}
