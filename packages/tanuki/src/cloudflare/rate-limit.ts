/**
 * Token bucket (decisions C4–C8).
 *
 * One bucket per Cloudflare account, because that is the real limit. The clock
 * is injected so the tests can run a five-minute refill in microseconds instead
 * of sleeping.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export interface TokenBucketPolicy {
  capacity: number;
  refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;

  constructor(
    private readonly policy: TokenBucketPolicy,
    private readonly clock: Clock,
  ) {
    this.tokens = policy.capacity;
    this.lastRefill = clock.now();
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  get pausedForMs(): number {
    return Math.max(0, this.pausedUntil - this.clock.now());
  }

  /** Non-blocking take, for callers that want to decide what to do next. */
  tryTake(): boolean {
    this.refill();
    if (this.clock.now() < this.pausedUntil) return false;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /**
   * Blocks until a request may be made. Honours an abort signal so cancelling a
   * purge does not leave a worker asleep for a minute.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    // Individual sleeps are capped so a cancel is noticed promptly instead of
    // waiting out a sixty-second refill.
    const MAX_SLEEP_MS = 250;

    for (;;) {
      if (signal?.aborted) throw new Error("aborted");

      const now = this.clock.now();
      if (now < this.pausedUntil) {
        await this.clock.sleep(Math.min(this.pausedUntil - now, MAX_SLEEP_MS));
        continue;
      }

      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / Math.max(this.policy.refillPerSecond, 0.0001)) * 1000);
      await this.clock.sleep(Math.min(Math.max(1, waitMs), MAX_SLEEP_MS));
    }
  }

  /**
   * Decision C8: after a 429/1134, pause the whole account rather than
   * hammering it zone by zone.
   */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + Math.max(0, ms));
  }

  /** Used after a rate-limit pause to avoid a burst straight afterwards. */
  drain(): void {
    this.tokens = 0;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.policy.capacity, this.tokens + elapsedSeconds * this.policy.refillPerSecond);
      this.lastRefill = now;
    }
  }
}

export interface AccountRateLimiterOptions {
  /** Plan tier per account ID. Unknown accounts fall back to the Free policy. */
  policyFor: (accountId: string) => TokenBucketPolicy;
  clock?: Clock;
}

export class AccountRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly policyFor: (accountId: string) => TokenBucketPolicy;
  private readonly clock: Clock;

  constructor(options: AccountRateLimiterOptions) {
    this.policyFor = options.policyFor;
    this.clock = options.clock ?? systemClock;
  }

  bucket(accountId: string): TokenBucket {
    const key = accountId || "unknown";
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.policyFor(key), this.clock);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  acquire(accountId: string, signal?: AbortSignal): Promise<void> {
    return this.bucket(accountId).acquire(signal);
  }

  pause(accountId: string, ms: number): void {
    this.bucket(accountId).pause(ms);
  }

  pausedForMs(accountId: string): number {
    return this.bucket(accountId).pausedForMs;
  }
}
