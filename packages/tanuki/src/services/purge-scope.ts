/**
 * What a purge is about to do, worked out before anything is sent.
 *
 * Decision U4 asks a confirmation to *name the counted scope*. That is this
 * file's whole job: turn "the user asked to purge this group" into a concrete
 * list of zones, the accounts holding them, and an honest estimate of the wait —
 * so the dialog can say "42 zones across 3 accounts, slowest plan Free at 5/min,
 * about 40s" rather than a vague "purge everything?".
 *
 * Three things are deliberately not glossed over:
 *
 *  - Stale zones stay *in scope* but are carried separately (decision C10), so
 *    the dialog can say they will be skipped instead of the count quietly
 *    disagreeing with the list the user sees.
 *  - Pacing is per account, and accounts run in parallel (decision C6), so the
 *    estimate is the slowest account's drain time, not the sum across accounts.
 *  - A stale zone number that is not in the configuration at all is ignored; a
 *    group is a set of zone IDs, and a dangling ID is not an error to invent.
 *  - An *ignored* zone is the user's own instruction rather than a failure, and
 *    is carried separately from a stale one: "I asked you not to touch this" and
 *    "this cannot be reached any more" are different sentences.
 */
import type { Group, PurgeRate, ZoneRecord } from "../config/schema.ts";
import { ignoredZones, purgeableZones, staleZones } from "../cloudflare/zones.ts";
import {
  asTier,
  estimateDurationMs,
  formatDuration,
  planLabel,
  policyFor,
  slowestTier,
} from "../cloudflare/plans.ts";
import type { BucketPolicy, PlanTier } from "../cloudflare/plans.ts";

/** The three things a user can aim a purge at. */
export type PurgeScope =
  | { kind: "zone"; zoneId: string }
  | { kind: "group"; groupId: string }
  | { kind: "all" };

/** One account's share of the work, and what it costs. */
export interface AccountLoad {
  accountId: string;
  /** Account name when Cloudflare gave one, otherwise the ID. */
  name: string;
  zones: number;
  /** Slowest plan among this account's zones — the one that sets its pace. */
  tier: PlanTier;
  policy: BucketPolicy;
  /** Time to drain this account's queue once the burst is spent. */
  estimateMs: number;
}

export interface ResolvedScope {
  scope: PurgeScope;
  /** Short noun phrase for the target: a domain, a group name, "every zone…". */
  label: string;
  /** The zones a purge would actually be sent for, in the config's order. */
  zones: ZoneRecord[];
  /** In scope but never sent, because they are stale. */
  skipped: ZoneRecord[];
  /** In scope but never sent, because the user asked Tanuki to leave them alone. */
  excluded: ZoneRecord[];
  /** One entry per account, slowest first. */
  accounts: AccountLoad[];
  /** The account that decides the wait; null when nothing is in scope. */
  bottleneck: AccountLoad | null;
  /** Longest single-account drain — the time the user actually waits. */
  estimateMs: number;
  /** True when the scope does not fit the burst, so pacing will be visible. */
  exceedsBurst: boolean;
  /** True when the scope matches nothing at all (no zones, stale or otherwise). */
  empty: boolean;
  /**
   * True when the thing the scope names is not in this configuration at all — a
   * group that was deleted, a zone that is gone. Distinguished from a target
   * that exists but is empty, because "no longer here" and "nothing in it" are
   * different answers and telling the user the wrong one is worse than saying
   * nothing.
   */
  targetMissing: boolean;
}

/**
 * Works out what a scope means against the configuration as it stands now.
 *
 * `zones` is the current list (which may include freshly discovered zones) and
 * `groups` the current groups, so this is always evaluated fresh rather than
 * against a snapshot taken when a screen opened.
 */
export function resolveScope(
  scope: PurgeScope,
  zones: readonly ZoneRecord[],
  groups: readonly Group[] = [],
  mode: PurgeRate = "auto",
): ResolvedScope {
  const matched = zonesInScope(scope, zones, groups);
  const live = purgeableZones(matched);
  const skipped = staleZones(matched);
  const excluded = ignoredZones(matched);
  const accounts = accountLoads(live, mode);
  const bottleneck = accounts[0] ?? null;

  return {
    scope,
    label: labelFor(scope, matched, groups),
    zones: live,
    skipped,
    excluded,
    accounts,
    bottleneck,
    estimateMs: bottleneck?.estimateMs ?? 0,
    exceedsBurst: (bottleneck?.estimateMs ?? 0) > 0,
    empty: matched.length === 0,
    targetMissing: scopeMissing(scope, zones, groups),
  };
}

/**
 * The body of the confirmation: the counted scope, in the order it should be
 * read. Kept here rather than in the component so the wording is testable on
 * its own and cannot drift between screens.
 */
export function scopeLines(resolved: ResolvedScope): string[] {
  if (resolved.zones.length === 0) {
    const heldBack: string[] = [];
    if (resolved.skipped.length > 0) heldBack.push("stale");
    if (resolved.excluded.length > 0) heldBack.push("ignored");
    return heldBack.length > 0
      ? [`Everything in scope is ${heldBack.join(" or ")}, so nothing would be sent.`]
      : ["There is nothing in scope to purge."];
  }

  const lines = [
    `${count(resolved.zones.length, "zone")} across ${count(resolved.accounts.length, "account")}.`,
  ];

  const bottleneck = resolved.bottleneck;
  if (bottleneck) {
    lines.push(`Slowest plan: ${planLabel(bottleneck.tier)} — ${bottleneck.policy.label}.`);
  }

  lines.push(
    resolved.exceedsBurst
      ? `That burst is not enough, so this paces out over ${formatDuration(resolved.estimateMs)}.`
      : "Every request goes out at once — this fits the burst limit.",
  );

  if (resolved.skipped.length > 0) {
    lines.push(`${count(resolved.skipped.length, "stale zone")} will be skipped.`);
  }
  if (resolved.excluded.length > 0) {
    lines.push(`${count(resolved.excluded.length, "ignored zone")} will be skipped.`);
  }

  return lines;
}

/**
 * Why a purge must not start, or null when it may. Returning a sentence rather
 * than a boolean keeps the "nothing to do" cases as explicit as the failures —
 * and keeps them *distinct*: a deleted group and a group with no zones in it are
 * different problems, and only one of them is the user's to fix.
 */
export function blockedReason(resolved: ResolvedScope): string | null {
  if (resolved.empty) {
    if (resolved.targetMissing) {
      return resolved.scope.kind === "group"
        ? "That group is no longer saved here, so there is nothing to purge."
        : "That zone is no longer in this configuration, so there is nothing to purge.";
    }
    if (resolved.scope.kind === "group") return "That group has no zones in it yet.";
    return "Nothing matched, so there is nothing to purge.";
  }
  if (resolved.zones.length === 0) {
    if (resolved.skipped.length > 0 && resolved.excluded.length > 0) {
      return "Every zone in scope is stale or ignored, so nothing would be sent to Cloudflare.";
    }
    if (resolved.excluded.length > 0) {
      return "Every zone in scope is ignored, so nothing would be sent to Cloudflare. Press i to show them.";
    }
    return "Every zone in scope is stale, so nothing would be sent to Cloudflare.";
  }
  return null;
}

/** Whether the scope names something that is not in the configuration at all. */
function scopeMissing(scope: PurgeScope, zones: readonly ZoneRecord[], groups: readonly Group[]): boolean {
  switch (scope.kind) {
    case "zone":
      return !zones.some((zone) => zone.id === scope.zoneId);
    case "group":
      return !groups.some((group) => group.id === scope.groupId);
    case "all":
      return false;
  }
}

function zonesInScope(
  scope: PurgeScope,
  zones: readonly ZoneRecord[],
  groups: readonly Group[],
): ZoneRecord[] {
  switch (scope.kind) {
    case "zone":
      return zones.filter((zone) => zone.id === scope.zoneId);
    case "group": {
      const group = groups.find((candidate) => candidate.id === scope.groupId);
      if (!group) return [];
      const members = new Set(group.zoneIds);
      return zones.filter((zone) => members.has(zone.id));
    }
    case "all":
      return [...zones];
  }
}

function labelFor(
  scope: PurgeScope,
  matched: readonly ZoneRecord[],
  groups: readonly Group[],
): string {
  switch (scope.kind) {
    case "zone":
      return matched[0]?.name ?? "this zone";
    case "group":
      return groups.find((group) => group.id === scope.groupId)?.name ?? "this group";
    case "all":
      return "every zone in this configuration";
  }
}

/**
 * One bucket per account, paced by the slowest plan among that account's zones
 * — the same rule the purge orchestrator applies, so the estimate and the
 * actual pacing agree.
 */
function accountLoads(zones: readonly ZoneRecord[], mode: PurgeRate): AccountLoad[] {
  const byAccount = new Map<string, { name: string; named: boolean; tiers: PlanTier[]; zones: number }>();

  for (const zone of zones) {
    const accountId = zone.accountId ?? "unknown";
    const entry = byAccount.get(accountId) ?? { name: accountId, named: false, tiers: [], zones: 0 };
    entry.tiers.push(asTier(zone.planId));
    entry.zones += 1;
    // Prefer a real account name over the ID fallback, whichever zone carries it.
    if (!entry.named && zone.accountName) {
      entry.name = zone.accountName;
      entry.named = true;
    }
    byAccount.set(accountId, entry);
  }

  return [...byAccount.entries()]
    .map(([accountId, entry]) => {
      const tier = slowestTier(entry.tiers);
      const policy = policyFor(tier, mode);
      return {
        accountId,
        name: entry.name,
        zones: entry.zones,
        tier,
        policy,
        estimateMs: estimateDurationMs(entry.zones, policy),
      };
    })
    .sort((a, b) => b.estimateMs - a.estimateMs || a.name.localeCompare(b.name));
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
