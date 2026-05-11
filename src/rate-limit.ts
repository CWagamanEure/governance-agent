/**
 * Per-user rate limit for LLM-bearing endpoints.
 *
 * Token-bucket per user_id, in-memory, single-process. Buckets refill
 * continuously at a constant rate; a burst up to `capacity` is allowed.
 * Resets on process restart, which is acceptable for a hackathon demo
 * (the TEE is a singleton and restarts are infrequent).
 *
 * Two limits today, both enforced together — whichever is hit first
 * rejects:
 *   - shortBurst: cap on a quick burst (default 30 calls / minute).
 *     Catches script loops that try to drain budget in one go.
 *   - hourly:    cap on sustained usage (default 200 calls / hour).
 *     Catches slow-and-steady loops that fly under the burst limit.
 *
 * Anonymous callers get keyed by a sentinel "anon" so they share a
 * single bucket — they should be a tiny minority since every cost-
 * bearing endpoint requires auth. The shared anon bucket is mostly a
 * defense-in-depth against a misconfigured handler that forgot
 * requireAuth.
 */

type Bucket = {
  // Tokens remaining for each window. Float because refill is continuous.
  burstTokens: number;
  hourlyTokens: number;
  // Last update timestamp (ms). One per window because the windows
  // refill at different rates.
  burstUpdatedAt: number;
  hourlyUpdatedAt: number;
};

export type RateLimitConfig = {
  burstCapacity: number;
  burstRefillPerMs: number;
  hourlyCapacity: number;
  hourlyRefillPerMs: number;
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; window: 'burst' | 'hourly'; retryAfterMs: number };

const DEFAULT_CONFIG: RateLimitConfig = {
  burstCapacity: 30, // 30 calls
  burstRefillPerMs: 30 / 60_000, // refills 30 tokens per 60s window
  hourlyCapacity: 200, // 200 calls
  hourlyRefillPerMs: 200 / (60 * 60_000), // refills 200 tokens per hour
};

const buckets = new Map<string, Bucket>();

function getBucket(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing) return existing;
  const fresh: Bucket = {
    burstTokens: DEFAULT_CONFIG.burstCapacity,
    hourlyTokens: DEFAULT_CONFIG.hourlyCapacity,
    burstUpdatedAt: now,
    hourlyUpdatedAt: now,
  };
  buckets.set(key, fresh);
  return fresh;
}

function refill(bucket: Bucket, now: number, cfg: RateLimitConfig) {
  const burstElapsed = Math.max(0, now - bucket.burstUpdatedAt);
  bucket.burstTokens = Math.min(
    cfg.burstCapacity,
    bucket.burstTokens + burstElapsed * cfg.burstRefillPerMs,
  );
  bucket.burstUpdatedAt = now;

  const hourlyElapsed = Math.max(0, now - bucket.hourlyUpdatedAt);
  bucket.hourlyTokens = Math.min(
    cfg.hourlyCapacity,
    bucket.hourlyTokens + hourlyElapsed * cfg.hourlyRefillPerMs,
  );
  bucket.hourlyUpdatedAt = now;
}

/**
 * Try to spend one token for `key`. Returns allowed:true if both
 * windows have capacity, or allowed:false with the limiting window
 * and a retry-after estimate in ms.
 */
export function takeToken(
  key: string,
  cfg: RateLimitConfig = DEFAULT_CONFIG,
  now: number = Date.now(),
): RateLimitDecision {
  const bucket = getBucket(key, now);
  refill(bucket, now, cfg);

  // Both windows must have ≥1 token. If either is short, reject and
  // estimate retry-after based on the shorter window's refill rate.
  if (bucket.burstTokens < 1) {
    const deficit = 1 - bucket.burstTokens;
    return {
      allowed: false,
      window: 'burst',
      retryAfterMs: Math.ceil(deficit / cfg.burstRefillPerMs),
    };
  }
  if (bucket.hourlyTokens < 1) {
    const deficit = 1 - bucket.hourlyTokens;
    return {
      allowed: false,
      window: 'hourly',
      retryAfterMs: Math.ceil(deficit / cfg.hourlyRefillPerMs),
    };
  }

  bucket.burstTokens -= 1;
  bucket.hourlyTokens -= 1;
  return { allowed: true };
}

/**
 * Test hook: clear all buckets. Not for use in production.
 */
export function _resetForTest(): void {
  buckets.clear();
}
