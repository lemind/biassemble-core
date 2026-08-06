// v10 §3c — placeholder, not yet confirmed (spec.md Assumption 5, Open Questions).
export const RATE_LIMIT_PER_IP_PER_HOUR = 5;
const WINDOW_MS = 60 * 60 * 1000;

interface Bucket {
  count: number;
  resetAt: number;
}

// In-memory, per-process — not a cross-instance guarantee on Vercel serverless. Known P0 gap, D020 §4.
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number = RATE_LIMIT_PER_IP_PER_HOUR,
    private readonly windowMs: number = WINDOW_MS
  ) {}

  /** True if this call is allowed (and consumes one unit); false if the caller is over limit. */
  checkAndConsume(ip: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) {
      return false;
    }
    bucket.count++;
    return true;
  }
}
