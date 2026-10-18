/**
 * Plan tiers and purge rate policies (decisions C4–C7).
 *
 * Cloudflare's purge limit is per *account* and shared across that account's
 * zones. The documented shape is a token bucket: an immediate burst, then a
 * sustained refill. Free is 5 requests/minute with a bucket of 25 — which means
 * a 24-zone purge is a single burst, not a five-minute crawl. Getting this
 * wrong in either direction matters: too fast creates partial failures, too
 * slow makes the tool feel broken.
 */

export type PlanTier = "free" | "lite" | "pro" | "business" | "enterprise" | "unknown";

export interface BucketPolicy {
  /** Burst capacity. */
  capacity: number;
  /** Sustained refill, requests per second. */
  refillPerSecond: number;
  /** For display: "5/min", "10/sec". */
  label: string;
}

export const POLICIES: Record<PlanTier, BucketPolicy> = {
  free: { capacity: 25, refillPerSecond: 5 / 60, label: "5/min" },
  // Lite is legacy and not in the current limits table. Treated as free: being
  // wrong in the slow direction costs seconds, being wrong the other way costs
  // a half-finished purge.
  lite: { capacity: 25, refillPerSecond: 5 / 60, label: "5/min" },
  pro: { capacity: 25, refillPerSecond: 5, label: "5/sec" },
  business: { capacity: 50, refillPerSecond: 10, label: "10/sec" },
  enterprise: { capacity: 500, refillPerSecond: 50, label: "50/sec" },
  unknown: { capacity: 25, refillPerSecond: 5 / 60, label: "5/min" },
};

/**
 * Normalises the several spellings Cloudflare uses across `plan.id`,
 * `plan.legacy_id` and `plan.name` (`free`, `FREE`, `PARTNERS_BIZ`, …).
 */
export function normalisePlan(raw: string | undefined | null): PlanTier {
  if (!raw) return "unknown";

  const value = raw.trim().toLowerCase().replace(/^partners?_/, "");

  switch (value) {
    case "free":
    case "partner_free":
      return "free";
    case "lite":
    case "pro_lite":
      return "lite";
    case "pro":
    case "professional":
      return "pro";
    case "business":
    case "biz":
      return "business";
    case "enterprise":
    case "ent":
      return "enterprise";
    default:
      return "unknown";
  }
}

/** Decision C7: `conservative` pins the Free ceiling; `auto` uses the plan. */
export function policyFor(tier: PlanTier, mode: "auto" | "conservative" = "auto"): BucketPolicy {
  return mode === "conservative" ? POLICIES.free : (POLICIES[tier] ?? POLICIES.unknown);
}

/**
 * The slowest policy across a set of tiers.
 *
 * Used wherever one account holds zones on different plans: an account's purge
 * limit is one bucket, so the safest member decides its pace. Seeding the search
 * with a default would be a bug — seeding with Free would drag every account
 * down to 5/minute.
 */
export function slowestPolicy(
  tiers: readonly (PlanTier | string)[],
  mode: "auto" | "conservative" = "auto",
): BucketPolicy {
  let chosen: BucketPolicy | undefined;
  for (const tier of tiers) {
    const candidate = policyFor(asTier(tier), mode);
    if (!chosen || candidate.refillPerSecond < chosen.refillPerSecond) chosen = candidate;
  }
  return chosen ?? POLICIES.unknown;
}

/** Coerces anything to a tier Tanuki has a policy for. */
export function asTier(value: string | undefined | null): PlanTier {
  return value !== null && value !== undefined && value in POLICIES ? (value as PlanTier) : "unknown";
}

const TIER_LABELS: Record<PlanTier, string> = {
  free: "Free",
  lite: "Lite",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
  unknown: "an unknown plan",
};

/** Display name for a tier. Cosmetics only — never used to decide pacing. */
export function planLabel(tier: PlanTier | string): string {
  return TIER_LABELS[asTier(tier)];
}

/** The plan a whole account should be shown as. Same rule as `slowestPolicy`. */
export function slowestTier(tiers: readonly (PlanTier | string)[]): PlanTier {
  // Seeded "unset", not "unknown": seeding with the fallback would stop every
  // real plan from ever being slower than it.
  let slowest: PlanTier | undefined;
  for (const tier of tiers) {
    const known = asTier(tier);
    if (slowest === undefined || POLICIES[known].refillPerSecond < POLICIES[slowest].refillPerSecond) {
      slowest = known;
    }
  }
  return slowest ?? "unknown";
}

/**
 * How long a scope will take, given a bucket. Zero when the whole scope fits in
 * the burst — which is the common case and the reason the confirmation dialog
 * only warns when it is genuinely slow (decision C9).
 */
export function estimateDurationMs(scope: number, policy: BucketPolicy): number {
  if (scope <= policy.capacity) return 0;
  const overflowSeconds = (scope - policy.capacity) / Math.max(policy.refillPerSecond, 0.0001);
  return Math.ceil(overflowSeconds * 1000);
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "immediately";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `about ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} min`;
}
