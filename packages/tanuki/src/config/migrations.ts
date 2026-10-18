/**
 * Schema migrations (decision D5).
 *
 * There is one version today. The chain exists from the start because the
 * alternative — discovering on the first breaking change that every read path
 * assumed the current shape — is how configuration files start getting thrown
 * away instead of migrated.
 */
import { CURRENT_SCHEMA_VERSION, manifestSchema, configSchema } from "./schema.ts";
import type { Manifest, TanukiConfig } from "./schema.ts";

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

type Raw = Record<string, unknown>;

/** Each entry migrates from version N to N+1. */
const manifestMigrations: Record<number, (raw: Raw) => Raw> = {};
const configMigrations: Record<number, (raw: Raw) => Raw> = {};

function schemaVersionOf(raw: Raw, what: string): number {
  const version = raw["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new SchemaError(
      `${what} has a missing or invalid schemaVersion. The file may be corrupt.`,
    );
  }
  return version;
}

function runChain(raw: Raw, version: number, migrations: Record<number, (raw: Raw) => Raw>, what: string): Raw {
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SchemaError(
      `${what} was written by a newer version of Tanuki (schema ${version}, this build understands ${CURRENT_SCHEMA_VERSION}). Upgrade Tanuki, or remove the file to start fresh.`,
    );
  }

  let current = raw;
  for (let v = version; v < CURRENT_SCHEMA_VERSION; v++) {
    const migrate = migrations[v];
    if (!migrate) {
      throw new SchemaError(`no migration from ${what} schema ${v} to ${v + 1}`);
    }
    current = migrate(current);
    current["schemaVersion"] = v + 1;
  }
  return current;
}

export function migrateManifest(raw: Raw): Manifest {
  const migrated = runChain(raw, schemaVersionOf(raw, "the configuration index"), manifestMigrations, "the configuration index");
  const result = manifestSchema.safeParse(migrated);
  if (!result.success) {
    throw new SchemaError(`the configuration index is not valid: ${summarise(result.error.issues)}`);
  }
  return result.data;
}

export function migrateConfig(raw: Raw, name = "the configuration"): TanukiConfig {
  const migrated = runChain(raw, schemaVersionOf(raw, name), configMigrations, name);
  const result = configSchema.safeParse(migrated);
  if (!result.success) {
    throw new SchemaError(`${name} is not valid: ${summarise(result.error.issues)}`);
  }
  return result.data;
}

function summarise(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const shown = issues
    .slice(0, 5)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  return issues.length > 5 ? `${shown}; and ${issues.length - 5} more` : shown;
}
