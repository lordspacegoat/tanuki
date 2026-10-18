import { describe, expect, test } from "bun:test";
import { AccountRateLimiter, TokenBucket } from "../src/cloudflare/rate-limit.ts";
import { FakeClock } from "./fake-cloudflare.ts";

describe("TokenBucket", () => {
  test("allows a burst up to capacity", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, clock);

    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  test("refills at the sustained rate", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, clock);

    bucket.tryTake();
    bucket.tryTake();
    expect(bucket.tryTake()).toBe(false);

    clock.advance(1_000);
    expect(bucket.tryTake()).toBe(true);
  });

  test("never exceeds capacity", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 100 }, clock);
    clock.advance(60_000);
    expect(bucket.available).toBe(2);
  });

  test("acquire waits exactly as long as the refill needs", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, clock);

    await bucket.acquire();
    expect(clock.now()).toBe(0);

    await bucket.acquire();
    expect(clock.now()).toBe(1_000);
  });

  test("a pause blocks the whole bucket", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 }, clock);

    bucket.pause(5_000);
    await bucket.acquire();
    expect(clock.now()).toBeGreaterThanOrEqual(5_000);
  });

  test("drain removes the remaining burst", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 }, clock);

    bucket.drain();
    expect(bucket.available).toBe(0);
    expect(bucket.tryTake()).toBe(false);
  });

  test("acquire honours an abort signal", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 0, refillPerSecond: 0.0001 }, clock);
    const controller = new AbortController();
    controller.abort();

    await expect(bucket.acquire(controller.signal)).rejects.toThrow(/aborted/);
  });
});

describe("AccountRateLimiter", () => {
  test("keeps a separate bucket per account", () => {
    const clock = new FakeClock();
    const limiter = new AccountRateLimiter({
      clock,
      policyFor: () => ({ capacity: 1, refillPerSecond: 1 }),
    });

    limiter.bucket("acct_a").tryTake();
    expect(limiter.bucket("acct_a").tryTake()).toBe(false);
    // A different account is a different limit.
    expect(limiter.bucket("acct_b").tryTake()).toBe(true);
  });

  test("pausing one account does not pause another", async () => {
    const clock = new FakeClock();
    const limiter = new AccountRateLimiter({
      clock,
      policyFor: () => ({ capacity: 5, refillPerSecond: 1 }),
    });

    limiter.pause("acct_a", 10_000);
    expect(limiter.pausedForMs("acct_a")).toBe(10_000);
    expect(limiter.pausedForMs("acct_b")).toBe(0);

    await limiter.acquire("acct_b");
    expect(clock.now()).toBe(0);
  });

  test("zones without an account share the unknown bucket", () => {
    const clock = new FakeClock();
    const limiter = new AccountRateLimiter({ clock, policyFor: () => ({ capacity: 1, refillPerSecond: 1 }) });
    expect(limiter.bucket("")).toBe(limiter.bucket("unknown"));
  });
});
