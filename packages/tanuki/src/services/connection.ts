/**
 * Connecting a configuration to Cloudflare (decisions S4, S9, D2).
 *
 * The order of operations here is a security property, not a style choice:
 *
 *   1. the name is checked locally, because that costs nothing;
 *   2. the token is proven against Cloudflare;
 *   3. zones are discovered;
 *   4. and only then is anything written to disk.
 *
 * A rejected, mistyped or under-scoped token therefore leaves no configuration
 * behind — not even an empty one. If the write half fails partway, the created
 * configuration is removed, because a configuration whose credential failed to
 * store is worse than none: it looks usable and is not.
 *
 * `replaceToken` below applies the same ordering to a token that already
 * exists: prove the new one, and only then overwrite the old one.
 */
import { CloudflareClient } from "../cloudflare/client.ts";
import { CloudflareError, userMessage } from "../cloudflare/errors.ts";
import { discoverZones, refreshZones } from "../cloudflare/zones.ts";
import type { RefreshResult } from "../cloudflare/zones.ts";
import { POLICIES, asTier, slowestTier } from "../cloudflare/plans.ts";
import type { PlanTier } from "../cloudflare/plans.ts";
import type { TanukiConfig, ZoneRecord } from "../config/schema.ts";
import type { ConfigManager } from "../config/manager.ts";
import { PassphraseCancelledError } from "../secrets/types.ts";
import type { CredentialMode } from "../secrets/types.ts";
import { redact } from "./redact.ts";

export type ConnectionFailureReason =
  | "empty-token"
  | "name-taken"
  | "invalid-name"
  | "token-rejected"
  | "token-not-active"
  | "missing-permission"
  | "network"
  | "cloudflare-unavailable"
  | "credential-store"
  | "interrupted"
  | "unknown";

export interface ConnectionFailure {
  ok: false;
  reason: ConnectionFailureReason;
  /** Ready to display. Already redacted. */
  message: string;
  /** True when a configuration was created and then removed again. */
  rolledBack: boolean;
  error?: CloudflareError;
}

export interface AccountSummary {
  id: string;
  name: string;
  zoneCount: number;
  /** The plan the whole account is paced at — the slowest of its zones. */
  tier: PlanTier;
  rateLabel: string;
}

export interface ConnectionSuccess {
  ok: true;
  config: TanukiConfig;
  zones: ZoneRecord[];
  accounts: AccountSummary[];
  pages: number;
  /** True when the safety cap was hit and the zone list is incomplete. */
  truncated: boolean;
}

export type ConnectionResult = ConnectionSuccess | ConnectionFailure;

export interface ConnectOptions {
  name: string;
  token: string;
  /** Defaults to whatever the store resolution preferred (decision S4). */
  mode?: CredentialMode;
  /** Injected by the tests; production builds one from the token. */
  client?: CloudflareClient;
  signal?: AbortSignal;
}

export async function connect(manager: ConfigManager, options: ConnectOptions): Promise<ConnectionResult> {
  // 1. Local checks first — no network, no writes.
  const token = normaliseToken(options.token);
  if (token.length === 0) {
    return failure("empty-token", "Paste a Cloudflare API token to continue.");
  }

  // Already cancelled: do not spend a round trip finding out.
  if (options.signal?.aborted) {
    return failure("interrupted", "Cancelled before the token was checked.");
  }

  const clash = await manager.findByName(options.name).catch(() => null);
  if (clash) {
    return failure("name-taken", `A configuration called "${clash.name}" already exists. Choose another name.`);
  }

  // 2. Prove the token. Nothing has been written at this point.
  const client = options.client ?? new CloudflareClient({ token });

  let verified: Awaited<ReturnType<CloudflareClient["verifyToken"]>>;
  try {
    verified = await client.verifyToken(options.signal);
  } catch (error) {
    return failureFrom(error, "verify");
  }

  if (verified.status !== "active") {
    // A token Cloudflare knows about but will not accept is a dead end, and
    // saying "verify" succeeded here would be a lie.
    return failure(
      "token-not-active",
      `Cloudflare reports this token as ${verified.status}. Create a new one with Zone → Zone → Read and Zone → Cache Purge → Purge.`,
    );
  }

  // 3. Discover zones while the token is known good.
  let discovered: Awaited<ReturnType<typeof discoverZones>>;
  try {
    discovered = await discoverZones(client, options.signal ? { signal: options.signal } : {});
  } catch (error) {
    return failureFrom(error, "list zones");
  }

  // 4. Write. The name is re-validated inside create(), which is the authority.
  let config: TanukiConfig;
  try {
    config = await manager.create(options.mode ? { name: options.name, mode: options.mode } : { name: options.name });
  } catch (error) {
    return failure("invalid-name", redact(messageOf(error)));
  }

  try {
    await manager.setCredential(config.id, token);
    const saved = await manager.save({ ...config, zones: discovered.zones });

    return {
      ok: true,
      config: saved,
      zones: saved.zones,
      accounts: summariseAccounts(saved.zones),
      pages: discovered.pages,
      truncated: discovered.truncated,
    };
  } catch (error) {
    // Compensating rollback. `remove` also clears any partial credential.
    const rolledBack = await manager
      .remove(config.id)
      .then(() => true)
      .catch(() => false);

    // A dismissed passphrase prompt is not a storage failure. Saying "the
    // credential store failed" would send the user hunting for a problem that
    // does not exist.
    if (error instanceof PassphraseCancelledError) {
      return {
        ...failure("interrupted", "Cancelled — no passphrase was set, so nothing was saved."),
        rolledBack,
      };
    }

    return {
      ...failure("credential-store", redact(messageOf(error))),
      rolledBack,
    };
  }
}

/**
 * Per-account rollup for the connect summary. The tier shown is the slowest
 * among the account's zones, matching how the purge engine will pace it — the
 * number on screen and the number in the rate limiter are the same number.
 */
export function summariseAccounts(zones: readonly ZoneRecord[]): AccountSummary[] {
  const byAccount = new Map<string, { id: string; name: string; tiers: PlanTier[]; count: number }>();

  for (const zone of zones) {
    const id = zone.accountId ?? "unknown";
    const entry = byAccount.get(id) ?? { id, name: zone.accountName ?? "Unknown account", tiers: [], count: 0 };
    entry.tiers.push(asTier(zone.planId));
    entry.count += 1;
    if (zone.accountName) entry.name = zone.accountName;
    byAccount.set(id, entry);
  }

  return [...byAccount.values()]
    .map((entry) => {
      const tier = slowestTier(entry.tiers);
      return {
        id: entry.id,
        name: entry.name,
        zoneCount: entry.count,
        tier,
        rateLabel: POLICIES[tier].label,
      };
    })
    .sort((a, b) => b.zoneCount - a.zoneCount || a.name.localeCompare(b.name));
}

/** Cloudflare tokens are opaque; surrounding whitespace from a paste never is. */
export function normaliseToken(raw: string): string {
  return raw.replace(/\s+/g, "");
}

// ------------------------------------------------------------- replacing a token

export interface ReplaceTokenOptions {
  /** The configuration whose credential is being replaced. */
  configId: string;
  token: string;
  client?: CloudflareClient;
  signal?: AbortSignal;
}

export interface ReplaceTokenSuccess {
  ok: true;
  /** The configuration with its refreshed zones, as saved. */
  config: TanukiConfig;
  /** What the re-discovery found, or null when it could not run. */
  refreshed: RefreshResult | null;
  /**
   * Set when the token was saved but the zone list could not be re-read. The
   * token is still the new one; saying so is better than pretending the whole
   * operation failed and inviting the user to paste it again.
   */
  warning?: string;
}

export type ReplaceTokenResult = ReplaceTokenSuccess | ConnectionFailure;

/**
 * Swaps the API token of an existing configuration (decision S9's ordering,
 * applied to a token that already exists).
 *
 * The old token keeps working until Cloudflare confirms the new one. A rejected
 * or dead token therefore changes nothing at all — not the credential and not
 * the zones — which is the whole point: a mistyped paste must be recoverable by
 * pasting again.
 *
 * Zones are re-read afterwards because the common reason to replace a token is
 * that its permissions changed, and a zone list discovered under the old token
 * is exactly the thing that would then be wrong.
 */
export async function replaceToken(
  manager: ConfigManager,
  options: ReplaceTokenOptions,
): Promise<ReplaceTokenResult> {
  const token = normaliseToken(options.token);
  if (token.length === 0) {
    return failure("empty-token", "Paste a Cloudflare API token to continue.");
  }
  if (options.signal?.aborted) {
    return failure("interrupted", "Cancelled before the token was checked.");
  }

  let config: TanukiConfig;
  try {
    config = await manager.load(options.configId);
  } catch (error) {
    return failure("unknown", redact(messageOf(error)));
  }

  const client = options.client ?? new CloudflareClient({ token });

  let verified: Awaited<ReturnType<CloudflareClient["verifyToken"]>>;
  try {
    verified = await client.verifyToken(options.signal);
  } catch (error) {
    return failureFrom(error, "verify");
  }

  if (verified.status !== "active") {
    return failure(
      "token-not-active",
      `Cloudflare reports this token as ${verified.status}. Create a new one with Zone → Zone → Read and Zone → Cache Purge → Purge.`,
    );
  }

  // Only now is anything written. If the store refuses, the old credential is
  // still the one in place.
  try {
    await manager.setCredential(config.id, token);
  } catch (error) {
    if (error instanceof PassphraseCancelledError) {
      return failure("interrupted", "Cancelled — your existing token is unchanged.");
    }
    return failure("credential-store", redact(messageOf(error)));
  }

  let refreshed: RefreshResult | null = null;
  try {
    refreshed = await refreshZones(client, config.zones, options.signal ? { signal: options.signal } : {});
  } catch (error) {
    return {
      ok: true,
      config,
      refreshed: null,
      warning: `The new token is saved, but the zone list could not be re-read: ${userMessage(error, "list zones")}`,
    };
  }

  try {
    const saved = await manager.save({ ...config, zones: refreshed.zones });
    return { ok: true, config: saved, refreshed };
  } catch (error) {
    return {
      ok: true,
      config,
      refreshed,
      warning: `The new token is saved, but the refreshed zones could not be written: ${redact(messageOf(error))}`,
    };
  }
}

function failure(reason: ConnectionFailureReason, message: string): ConnectionFailure {
  return { ok: false, reason, message, rolledBack: false };
}

function failureFrom(error: unknown, action: "verify" | "list zones"): ConnectionFailure {
  if (error instanceof CloudflareError) {
    const reason: ConnectionFailureReason =
      error.kind === "auth"
        ? "token-rejected"
        : error.kind === "permission"
          ? "missing-permission"
          : error.kind === "network" || error.kind === "timeout"
            ? "network"
            : error.kind === "server"
              ? "cloudflare-unavailable"
              : "unknown";
    return { ok: false, reason, message: userMessage(error, action), rolledBack: false, error };
  }

  if (error instanceof Error && error.message === "aborted") {
    return failure("interrupted", "Cancelled before the token was checked.");
  }

  return failure("unknown", redact(messageOf(error)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
