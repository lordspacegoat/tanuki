import { describe, expect, test } from "bun:test";
import {
  POLICIES,
  asTier,
  estimateDurationMs,
  formatDuration,
  normalisePlan,
  policyFor,
  slowestPolicy,
  slowestTier,
} from "../src/cloudflare/plans.ts";
import type { PlanTier } from "../src/cloudflare/plans.ts";

describe("normalisePlan", () => {
  const cases: Array<[string, PlanTier]> = [
    ["free", "free"],
    ["FREE", "free"],
    ["PARTNERS_FREE", "free"],
    ["pro", "pro"],
    ["PRO", "pro"],
    ["business", "business"],
    ["BIZ", "business"],
    ["PARTNERS_BIZ", "business"],
    ["enterprise", "enterprise"],
    ["ENT", "enterprise"],
    ["lite", "lite"],
  ];

  for (const [input, expected] of cases) {
    test(`${input} -> ${expected}`, () => {
      expect(normalisePlan(input)).toBe(expected);
    });
  }

  test("unknown and missing values are unknown, not a guess", () => {
    expect(normalisePlan(undefined)).toBe("unknown");
    expect(normalisePlan(null)).toBe("unknown");
    expect(normalisePlan("")).toBe("unknown");
    expect(normalisePlan("quantum")).toBe("unknown");
  });
});

describe("rate policies", () => {
  test("Free is a burst of 25 refilling at 5/min", () => {
    expect(POLICIES.free.capacity).toBe(25);
    expect(POLICIES.free.refillPerSecond).toBeCloseTo(5 / 60, 6);
  });

  test("conservative mode pins the Free ceiling regardless of plan", () => {
    expect(policyFor("enterprise", "conservative")).toBe(POLICIES.free);
    expect(policyFor("enterprise", "auto")).toBe(POLICIES.enterprise);
  });

  test("an unknown tier falls back to Free rather than unlimited", () => {
    expect(policyFor("unknown", "auto")).toBe(POLICIES.unknown);
    expect(POLICIES.unknown.refillPerSecond).toBe(POLICIES.free.refillPerSecond);
  });

  test("a scope inside the burst is immediate", () => {
    // This is the case that matters: 24 zones on Free is one burst, not five minutes.
    expect(estimateDurationMs(24, POLICIES.free)).toBe(0);
  });

  test("a scope beyond the burst is estimated from the refill rate", () => {
    expect(estimateDurationMs(55, POLICIES.free)).toBe(360_000);
  });

  test("durations read like a human wrote them", () => {
    expect(formatDuration(0)).toBe("immediately");
    expect(formatDuration(3_000)).toBe("about 3s");
    expect(formatDuration(360_000)).toBe("about 6 min");
  });
});

describe("choosing one plan for a set of zones", () => {
  test("asTier accepts only plans Tanuki has a policy for", () => {
    expect(asTier("pro")).toBe("pro");
    expect(asTier("quantum")).toBe("unknown");
    expect(asTier(undefined)).toBe("unknown");
    expect(asTier(null)).toBe("unknown");
    expect(asTier("")).toBe("unknown");
  });

  test("slowestTier picks the slowest plan, not the default", () => {
    // Regression: seeding the search with the fallback made every comparison
    // lose, so a mixed account was reported as unknown.
    expect(slowestTier(["enterprise", "free"])).toBe("free");
    expect(slowestTier(["enterprise", "pro"])).toBe("pro");
    expect(slowestTier(["enterprise"])).toBe("enterprise");
    expect(slowestTier(["free", "free"])).toBe("free");
  });

  test("slowestTier falls back only when there is nothing to compare", () => {
    expect(slowestTier([])).toBe("unknown");
    expect(slowestTier(["quantum"])).toBe("unknown");
  });

  test("slowestPolicy agrees with slowestTier", () => {
    expect(slowestPolicy(["enterprise", "free"])).toBe(POLICIES.free);
    expect(slowestPolicy(["business"])).toBe(POLICIES.business);
    expect(slowestPolicy([])).toBe(POLICIES.unknown);
    // An unrecognised tier is treated as the conservative floor, not as fast.
    expect(slowestPolicy(["quantum"])).toBe(POLICIES.unknown);
  });

  test("conservative mode collapses any set to the Free ceiling", () => {
    expect(slowestPolicy(["enterprise", "business"], "conservative")).toBe(POLICIES.free);
  });
});
