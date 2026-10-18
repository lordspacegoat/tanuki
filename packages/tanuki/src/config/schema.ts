/**
 * On-disk schemas (decision D1, D3, D5, D7).
 *
 * Timestamps are plain strings rather than a date format check: the file is
 * ours, and being strict about ISO formatting buys a worse failure mode than it
 * prevents. IDs are opaque; nothing about them is parsed back out.
 */
import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1;

/** Decision D4. */
export const NAME_MAX_LENGTH = 64;

/** Decision S1/S3: config files hold a reference, never a secret. */
export const credentialRefSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("keychain"),
    /** Keychain account key. Always the config ID, so renames cannot orphan it. */
    ref: z.string().min(1),
  }),
  z.object({
    mode: z.literal("passphrase"),
    /** Vault filename inside `vaults/`, relative. */
    vault: z.string().min(1),
  }),
]);
export type CredentialRef = z.infer<typeof credentialRefSchema>;

/** Decision C10: absence from /zones is not self-describing, so we probe. */
export const staleReasonSchema = z.enum(["not-permitted", "gone", "unknown"]);
export type StaleReason = z.infer<typeof staleReasonSchema>;

export const zoneStatusSchema = z.enum(["initializing", "pending", "active", "moved", "unknown"]);
export type ZoneStatus = z.infer<typeof zoneStatusSchema>;

export const zoneRecordSchema = z.object({
  /** Cloudflare zone ID. The stable identifier — never the domain name. */
  id: z.string().min(1),
  name: z.string().min(1),
  status: zoneStatusSchema,
  accountId: z.string().optional(),
  accountName: z.string().optional(),
  /** Plan identifier, normalised. Drives the rate bucket (decision C5). */
  planId: z.string().optional(),
  /** Set when the zone stopped appearing in the token's zone list. */
  stale: z
    .object({
      reason: staleReasonSchema,
      detectedAt: z.string(),
    })
    .optional(),
  /**
   * Set when the user asked Tanuki to stop purging this zone. Kept on the
   * record rather than deleting it, for two reasons: a refresh re-discovers
   * every zone the token can reach, so a deleted row would come straight back;
   * and an ignored zone is still a zone, with an ID worth keeping.
   *
   * Ignored zones are never purged and are hidden from the list until `i`.
   */
  ignored: z.boolean().optional(),
  /** The last purge attempt, so the detail pane can say when and how it went. */
  lastPurge: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      /** Cloudflare's acknowledgement identifier, when one came back. */
      purgeId: z.string().optional(),
      /** Why it failed, when it did. */
      reason: z.string().optional(),
      /** Round trip, in milliseconds, when there was one. */
      durationMs: z.number().optional(),
    })
    .optional(),
});
export type ZoneRecord = z.infer<typeof zoneRecordSchema>;

export const groupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Zone IDs (decision D7). Multi-membership is expected, not an error. */
  zoneIds: z.array(z.string().min(1)),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Group = z.infer<typeof groupSchema>;

/** Decision C7: one preference, deliberately. */
export const purgeRateSchema = z.enum(["auto", "conservative"]);
export type PurgeRate = z.infer<typeof purgeRateSchema>;

export const prefsSchema = z.object({
  purgeRate: purgeRateSchema.default("auto"),
});
export type Prefs = z.infer<typeof prefsSchema>;

export const configSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  credential: credentialRefSchema,
  zones: z.array(zoneRecordSchema),
  groups: z.array(groupSchema),
  prefs: prefsSchema,
});
export type TanukiConfig = z.infer<typeof configSchema>;

export const manifestEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** `null` means "ask the user", which is the spec's default behaviour. */
  activeConfigId: z.string().nullable(),
  configs: z.array(manifestEntrySchema),
  prefs: prefsSchema,
});
export type Manifest = z.infer<typeof manifestSchema>;

export function emptyManifest(): Manifest {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeConfigId: null,
    configs: [],
    prefs: { purgeRate: "auto" },
  };
}

export type NameValidation = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Decision D4: trimmed, non-empty, within length, no control characters.
 * Uniqueness is *not* checked here — that needs the peer set, so it belongs
 * with the caller that has one.
 */
export function validateName(raw: string, label = "name"): NameValidation {
  const name = raw.trim();

  if (name.length === 0) {
    return { ok: false, reason: `a ${label} cannot be empty` };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, reason: `a ${label} cannot be longer than ${NAME_MAX_LENGTH} characters` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, reason: `a ${label} cannot contain control characters` };
  }

  return { ok: true, name };
}

/** Case-insensitive comparison used for uniqueness (decision D4). */
export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}
