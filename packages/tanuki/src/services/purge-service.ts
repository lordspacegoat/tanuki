/**
 * Purge orchestration (decisions C4–C12, U4–U6).
 *
 * The rules this file exists to enforce:
 *
 *  - One request in flight per Cloudflare account, at most two accounts at a
 *    time. Per-account rate limits are the constraint; parallelism across
 *    accounts is the only safe parallelism.
 *  - A rate-limited zone is *re-queued*, not failed — but only twice. After
 *    that the truth is that we could not purge it, and the summary says so.
 *  - A success is only recorded when Cloudflare acknowledged the request.
 *  - Nothing marked stale is purged. It is skipped, and listed as skipped.
 *  - Cancelling stops new work and says plainly that requests already sent
 *    cannot be recalled. It never pretends to have rolled anything back.
 */
import type { CloudflareClient } from "../cloudflare/client.ts";
import { CloudflareError, userMessage } from "../cloudflare/errors.ts";
import type { CloudflareErrorKind } from "../cloudflare/errors.ts";
import { AccountRateLimiter, systemClock } from "../cloudflare/rate-limit.ts";
import type { Clock } from "../cloudflare/rate-limit.ts";
import { POLICIES, asTier, policyFor, slowestPolicy } from "../cloudflare/plans.ts";
import type { PlanTier } from "../cloudflare/plans.ts";
import type { ZoneRecord } from "../config/schema.ts";

export type OutcomeStatus = "pending" | "accepted" | "failed" | "skipped";

export interface ZoneOutcome {
  zoneId: string;
  name: string;
  accountId: string;
  status: OutcomeStatus;
  /** Total attempts, including the first. */
  attempts: number;
  /** Human-readable reason for a skip or failure. */
  reason?: string;
  errorKind?: CloudflareErrorKind;
  /** Cloudflare's acknowledgement identifier, when accepted. */
  acceptedId?: string;
  /** The HTTP status Cloudflare answered with, when it answered at all. */
  httpStatus?: number;
  /** Round trip for the accepted request, in milliseconds. */
  durationMs?: number;
  /** Any `messages` Cloudflare attached — a warning worth showing, not swallowing. */
  messages?: string[];
}

export interface PurgeProgress {
  total: number;
  completed: number;
  accepted: number;
  failed: number;
  skipped: number;
  outcomes: readonly ZoneOutcome[];
}

export interface PurgeSummary extends PurgeProgress {
  startedAt: string;
  durationMs: number;
  cancelled: boolean;
}

export interface PurgeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PurgeProgress) => void;
  /** Decision C8: re-queues after a 429/1134 before reporting failure. */
  maxRateLimitRetries?: number;
  /** Decision C6: global cap across accounts. */
  maxConcurrency?: number;
  /** Decision C7. */
  rateMode?: "auto" | "conservative";
  clock?: Clock;
  now?: () => number;
}

interface Queued {
  zone: ZoneRecord;
  attempts: number;
  rateLimitRetries: number;
}

export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;
export const DEFAULT_MAX_CONCURRENCY = 2;

export async function purgeZones(
  client: CloudflareClient,
  zones: readonly ZoneRecord[],
  options: PurgeOptions = {},
): Promise<PurgeSummary> {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const maxRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);

  const outcomes = new Map<string, ZoneOutcome>();
  for (const zone of zones) {
    outcomes.set(zone.id, {
      zoneId: zone.id,
      name: zone.name,
      accountId: zone.accountId ?? "unknown",
      status: "pending",
      attempts: 0,
    });
  }

  // Stale zones never reach the network (decision C10).
  for (const zone of zones) {
    if (zone.stale) {
      const outcome = outcomes.get(zone.id)!;
      outcome.status = "skipped";
      outcome.reason = staleReasonText(zone.stale.reason);
    }
  }

  const queues = new Map<string, Queued[]>();
  for (const zone of zones) {
    if (zone.stale) continue;
    const accountId = zone.accountId ?? "unknown";
    const queue = queues.get(accountId) ?? [];
    queue.push({ zone, attempts: 0, rateLimitRetries: 0 });
    queues.set(accountId, queue);
  }

  const limiter = buildLimiter(zones, options.rateMode ?? "auto", clock);
  const accountIds = [...queues.keys()];
  let cursor = 0;
  let cancelled = options.signal?.aborted === true;

  const emit = () => options.onProgress?.(snapshot(outcomes, zones.length));

  const processOne = async (accountId: string, item: Queued, requeue: (next: Queued) => void): Promise<void> => {
    const outcome = outcomes.get(item.zone.id)!;
    item.attempts += 1;
    outcome.attempts = item.attempts;

    try {
      await limiter.acquire(accountId, options.signal);
      const accepted = await client.purgeEverything(item.zone.id, options.signal);
      outcome.status = "accepted";
      outcome.acceptedId = accepted.id;
      outcome.httpStatus = accepted.status;
      outcome.durationMs = accepted.durationMs;
      if (accepted.messages.length > 0) outcome.messages = accepted.messages;
      delete outcome.reason;
      delete outcome.errorKind;
    } catch (error) {
      if (isCancellation(error, options.signal)) {
        outcome.status = "skipped";
        outcome.reason = "cancelled before this zone was purged";
        return;
      }

      if (error instanceof CloudflareError && error.kind === "rate-limit" && item.rateLimitRetries < maxRetries) {
        // Decision C8: pause the whole account, put the zone back in the queue,
        // and do not count this as a failure yet.
        limiter.pause(accountId, error.retryAfterMs);
        requeue({ ...item, rateLimitRetries: item.rateLimitRetries + 1 });
        outcome.reason = `rate limited — retrying in ${Math.round(error.retryAfterMs / 1000)}s`;
        return;
      }

      outcome.status = "failed";
      outcome.errorKind = error instanceof CloudflareError ? error.kind : "unknown";
      outcome.reason = userMessage(error, "purge");
    } finally {
      emit();
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) {
        cancelled = true;
        return;
      }

      const accountId = accountIds[cursor++];
      if (accountId === undefined) return;

      const queue = queues.get(accountId)!;
      while (queue.length > 0) {
        if (options.signal?.aborted) {
          cancelled = true;
          return;
        }
        const item = queue.shift()!;
        await processOne(accountId, item, (next) => queue.push(next));
      }
    }
  };

  const workers = Math.min(maxConcurrency, Math.max(accountIds.length, 1));
  await Promise.all(Array.from({ length: workers }, worker));

  if (options.signal?.aborted) cancelled = true;

  // Anything never attempted — because of cancellation — is skipped, not failed.
  for (const outcome of outcomes.values()) {
    if (outcome.status === "pending") {
      outcome.status = "skipped";
      outcome.reason = cancelled ? "cancelled before this zone was purged" : "not attempted";
    }
  }

  const summary = snapshot(outcomes, zones.length);
  return {
    ...summary,
    startedAt,
    durationMs: Math.max(0, now() - startedAtMs),
    cancelled,
  };
}

function snapshot(outcomes: Map<string, ZoneOutcome>, total: number): PurgeProgress {
  const list = [...outcomes.values()];
  return {
    total,
    completed: list.filter((outcome) => outcome.status !== "pending").length,
    accepted: list.filter((outcome) => outcome.status === "accepted").length,
    failed: list.filter((outcome) => outcome.status === "failed").length,
    skipped: list.filter((outcome) => outcome.status === "skipped").length,
    outcomes: list,
  };
}

/**
 * One bucket per account, paced by the slowest plan among that account's zones.
 * One account can hold zones on different plans; honouring only the fastest
 * would be a lie about the limit.
 */
function buildLimiter(
  zones: readonly ZoneRecord[],
  mode: "auto" | "conservative",
  clock: Clock,
): AccountRateLimiter {
  const tiersByAccount = tierMap(zones);

  return new AccountRateLimiter({
    clock,
    policyFor: (accountId) => slowestPolicy(tiersByAccount.get(accountId) ?? ["unknown"], mode),
  });
}

/** Groups an account's zones by plan tier, for pacing and for display. */
export function tierMap(zones: readonly ZoneRecord[]): Map<string, PlanTier[]> {
  const tiers = new Map<string, PlanTier[]>();

  for (const zone of zones) {
    const accountId = zone.accountId ?? "unknown";
    const tier = asTier(zone.planId);
    const list = tiers.get(accountId) ?? [];
    list.push(tier);
    tiers.set(accountId, list);
  }

  return tiers;
}

function staleReasonText(reason: "not-permitted" | "gone" | "unknown"): string {
  switch (reason) {
    case "not-permitted":
      return "this token can no longer reach this zone";
    case "gone":
      return "this zone no longer exists on Cloudflare";
    case "unknown":
      return "this zone's status could not be confirmed";
  }
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  if (error.message === "aborted" || error.name === "AbortError") return true;
  return error.name === "CloudflareError" && /cancelled/i.test(error.message);
}

/** Decision U6: retry failed zones only — never re-send a success. */
export function failedZoneIds(summary: PurgeSummary): string[] {
  return summary.outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.zoneId);
}

export function retryableZones(summary: PurgeSummary, zones: readonly ZoneRecord[]): ZoneRecord[] {
  const failed = new Set(failedZoneIds(summary));
  return zones.filter((zone) => failed.has(zone.id));
}

/**
 * Writes what a run established back onto the zone records, so the detail pane
 * can answer "when was this last purged, and did it work?" without keeping a
 * second log beside the configuration.
 *
 * Every zone the run was given is stamped — accepted, failed or skipped — since
 * "we tried and it failed" is the answer the user needs to see, and leaving the
 * record untouched would keep showing a stale success. Zones the run never
 * mentioned are returned as they were.
 *
 * The timestamp is the run's end rather than its start: for a long paced purge,
 * "when was it purged" means the last request, not the first.
 */
export function applyPurgeSummary(
  zones: readonly ZoneRecord[],
  summary: PurgeSummary,
): ZoneRecord[] {
  const byId = new Map(summary.outcomes.map((outcome) => [outcome.zoneId, outcome]));
  const at = new Date(Date.parse(summary.startedAt) + summary.durationMs).toISOString();

  return zones.map((zone) => {
    const outcome = byId.get(zone.id);
    if (!outcome) return zone;

    return {
      ...zone,
      lastPurge: {
        at,
        ok: outcome.status === "accepted",
        ...(outcome.acceptedId ? { purgeId: outcome.acceptedId } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
      },
    };
  });
}

export function isCompleteSuccess(summary: PurgeSummary): boolean {
  return summary.failed === 0 && summary.skipped === 0 && !summary.cancelled;
}
