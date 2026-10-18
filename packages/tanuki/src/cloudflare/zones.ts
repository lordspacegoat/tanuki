/**
 * Zone discovery (decision C2) and reconciliation (decision C10).
 *
 * Two things worth knowing before reading this:
 *
 * 1. `per_page` caps at 50. An account with thousands of zones is dozens of
 *    round trips, so pagination is not an edge case here.
 * 2. A zone that vanishes from `/zones` could be gone or could simply be
 *    outside this token's scope. Cloudflare's status enum has no `deleted`, so
 *    the difference has to be probed. Guessing would be worse than asking.
 */
import type { CloudflareClient } from "./client.ts";
import type { RawZone } from "./types.ts";
import type { ZoneRecord, ZoneStatus } from "../config/schema.ts";
import { normalisePlan } from "./plans.ts";
import type { PlanTier } from "./plans.ts";

const PER_PAGE = 50;
/** Safety valve: 400 pages is 20,000 zones, far past Cloudflare's account cap. */
const MAX_PAGES = 400;

export interface DiscoveryResult {
  zones: ZoneRecord[];
  pages: number;
  /** True when the safety cap was hit — the caller should say so, not hide it. */
  truncated: boolean;
}

export function planTierFor(zone: RawZone): PlanTier {
  return normalisePlan(zone.plan?.id ?? zone.plan?.legacy_id ?? zone.plan?.name);
}

export function toZoneRecord(zone: RawZone): ZoneRecord {
  const status = isZoneStatus(zone.status) ? zone.status : "unknown";

  return {
    id: zone.id,
    name: zone.name,
    status,
    ...(zone.account?.id ? { accountId: zone.account.id } : {}),
    ...(zone.account?.name ? { accountName: zone.account.name } : {}),
    ...(zone.plan ? { planId: planTierFor(zone) } : {}),
  };
}

function isZoneStatus(value: string): value is ZoneStatus {
  return value === "initializing" || value === "pending" || value === "active" || value === "moved";
}

export interface DiscoverOptions {
  signal?: AbortSignal;
  onPage?: (page: number, totalPages: number, soFar: number) => void;
  perPage?: number;
}

/** Fetches every zone the token can reach, following pagination to the end. */
export async function discoverZones(
  client: CloudflareClient,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const seen = new Map<string, ZoneRecord>();
  let page = 1;
  let pages = 0;
  let totalPages = 1;
  let truncated = false;

  for (; page <= totalPages; page++) {
    if (page > MAX_PAGES) {
      truncated = true;
      break;
    }

    const response = await client.listZonesPage(
      { page, perPage: options.perPage ?? PER_PAGE },
      options.signal,
    );

    pages += 1;
    totalPages = response.resultInfo?.total_pages ?? page;

    for (const zone of response.zones) {
      seen.set(zone.id, toZoneRecord(zone));
    }

    options.onPage?.(page, totalPages, seen.size);

    // A short page on an endpoint that did not report total_pages means we are
    // done; otherwise trust total_pages.
    if (!response.resultInfo && response.zones.length < (options.perPage ?? PER_PAGE)) break;
  }

  return { zones: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)), pages, truncated };
}

export type StaleReason = "not-permitted" | "gone" | "unknown";

export interface RefreshChanges {
  added: ZoneRecord[];
  updated: ZoneRecord[];
  /** Zones that disappeared, with the reason the probe established. */
  stale: Array<{ zone: ZoneRecord; reason: StaleReason }>;
  /** Previously stale zones that came back. */
  restored: ZoneRecord[];
}

export interface RefreshResult {
  zones: ZoneRecord[];
  changes: RefreshChanges;
}

export interface RefreshOptions {
  signal?: AbortSignal;
  onPage?: DiscoverOptions["onPage"];
  /** How many disappearance probes to run at once. Deliberately small. */
  probeConcurrency?: number;
  now?: () => string;
}

/**
 * Merges a fresh discovery into existing local state.
 *
 * Group membership is never touched here — that is the whole point of
 * decision C10. A zone that vanished keeps its place in every group, is marked
 * stale, and waits for the user to resolve it.
 */
export async function refreshZones(
  client: CloudflareClient,
  existing: readonly ZoneRecord[],
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const discovered = await discoverZones(client, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onPage ? { onPage: options.onPage } : {}),
  });

  const byId = new Map(discovered.zones.map((zone) => [zone.id, zone]));
  const existingById = new Map(existing.map((zone) => [zone.id, zone]));

  const added: ZoneRecord[] = [];
  const updated: ZoneRecord[] = [];
  const restored: ZoneRecord[] = [];
  const vanished: ZoneRecord[] = [];

  const retained: ZoneRecord[] = [];

  for (const zone of existing) {
    const fresh = byId.get(zone.id);
    if (fresh) {
      // Deliberately not `{ ...fresh }`: the two fields the user owns rather
      // than Cloudflare do not appear in the discovery result, and dropping
      // them here would silently un-ignore a zone and forget when it was last
      // purged — on the very refresh the user pressed to tidy things up.
      const merged: ZoneRecord = {
        ...fresh,
        ...(zone.ignored ? { ignored: true } : {}),
        ...(zone.lastPurge ? { lastPurge: zone.lastPurge } : {}),
      };
      if (zone.stale) restored.push(merged);
      retained.push(merged);
      if (hasChanged(zone, merged)) updated.push(merged);
      byId.delete(zone.id);
    } else {
      vanished.push(zone);
      retained.push(zone);
    }
  }

  for (const zone of byId.values()) {
    added.push(zone);
    retained.push(zone);
  }

  const probes = await probeVanished(client, vanished, options);
  const staleById = new Map(probes.map((probe) => [probe.zoneId, probe.reason]));

  const zones = retained.map((zone) => {
    const reason = staleById.get(zone.id);
    if (reason === undefined) return zone;
    return {
      ...zone,
      stale: { reason, detectedAt: (options.now ?? (() => new Date().toISOString()))() },
    };
  });

  // Report only newly-stale zones, not ones that were already flagged.
  const stale = zones
    .filter((zone) => zone.stale && !existingById.get(zone.id)?.stale)
    .map((zone) => ({ zone, reason: zone.stale!.reason }));

  zones.sort((a, b) => a.name.localeCompare(b.name));

  return { zones, changes: { added, updated, stale, restored } };
}

function hasChanged(before: ZoneRecord, after: ZoneRecord): boolean {
  return (
    before.name !== after.name ||
    before.status !== after.status ||
    before.accountId !== after.accountId ||
    before.accountName !== after.accountName ||
    before.planId !== after.planId
  );
}

interface Probe {
  zoneId: string;
  reason: StaleReason;
}

/**
 * One `GET /zones/{id}` per vanished zone. Normally zero requests, since zones
 * rarely disappear — and when they do, this is the only way to tell a revoked
 * token from a deleted zone.
 */
async function probeVanished(
  client: CloudflareClient,
  vanished: readonly ZoneRecord[],
  options: RefreshOptions,
): Promise<Probe[]> {
  if (vanished.length === 0) return [];

  const limits = Math.max(1, options.probeConcurrency ?? 2);
  const results: Probe[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const zone = vanished[index];
      if (!zone) return;
      const reason = await probeOne(client, zone, options.signal);
      if (reason !== null) results.push({ zoneId: zone.id, reason });
    }
  };

  await Promise.all(Array.from({ length: Math.min(limits, vanished.length) }, worker));
  return results;
}

/** Returns null when the probe proved the zone is still reachable. */
async function probeOne(
  client: CloudflareClient,
  zone: ZoneRecord,
  signal: AbortSignal | undefined,
): Promise<StaleReason | null> {
  try {
    const found = await client.getZone(zone.id, signal);
    if (found !== null) {
      // Reachable by ID but absent from the token-scoped listing. That is not
      // staleness, and inventing a reason for it would be worse than silence.
      return null;
    }
    return "gone";
  } catch (error) {
    const kind = (error as { kind?: string }).kind;
    if (kind === "not-found") return "gone";
    if (kind === "permission" || kind === "auth") return "not-permitted";
    return "unknown";
  }
}

/**
 * The subset a purge should actually attempt (decisions C9/C10).
 *
 * Two kinds of zone are excluded and both are the user's own decision rather
 * than Cloudflare's: a stale zone (the token can no longer reach it) and an
 * ignored one (the user asked Tanuki to leave it alone). Neither is ever sent a
 * request, and both are reported as skipped rather than quietly dropped.
 */
export function purgeableZones(zones: readonly ZoneRecord[]): ZoneRecord[] {
  return zones.filter((zone) => !zone.stale && !isIgnored(zone));
}

export function staleZones(zones: readonly ZoneRecord[]): ZoneRecord[] {
  return zones.filter((zone) => zone.stale !== undefined);
}

/** Zones the user asked Tanuki to stop purging. Never sent a request. */
export function ignoredZones(zones: readonly ZoneRecord[]): ZoneRecord[] {
  return zones.filter(isIgnored);
}

/** How a purge scope accounts for a zone that will never be sent. */
export function isIgnored(zone: ZoneRecord): boolean {
  return zone.ignored === true;
}
