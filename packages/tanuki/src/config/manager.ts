/**
 * Configuration lifecycle (decisions D1–D7).
 *
 * Owns the manifest and the per-configuration files, and is the only thing that
 * pairs a configuration with its credential. The TUI never reads a file and
 * never touches a credential store directly.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  emptyManifest,
  manifestSchema,
  nameKey,
  validateName,
  configSchema,
} from "./schema.ts";
import type { CredentialRef, Manifest, ManifestEntry, Prefs, TanukiConfig } from "./schema.ts";
import { migrateConfig, migrateManifest, SchemaError } from "./migrations.ts";
import { readFileIfExists, removeFile, writeFileAtomic, FILE_MODE } from "./storage.ts";
import type { TanukiPaths } from "./paths.ts";
import { storeFor } from "../secrets/store.ts";
import type { CredentialStores } from "../secrets/store.ts";
import { CredentialUnavailableError, PassphraseCancelledError } from "../secrets/types.ts";
import type { CredentialMode } from "../secrets/types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The file exists but cannot be understood (decision §14). */
export class ConfigCorruptError extends ConfigError {
  constructor(
    message: string,
    readonly path: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigCorruptError";
  }
}

export interface CreateConfigInput {
  name: string;
  /** Defaults to `stores.preferred` (decision S4). */
  mode?: CredentialMode;
  prefs?: Partial<Prefs>;
}

export class ConfigManager {
  constructor(
    private readonly paths: TanukiPaths,
    private readonly stores: CredentialStores,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private configFile(id: string): string {
    return join(this.paths.configsDir, `${id}.json`);
  }

  // ---------------------------------------------------------------- manifest

  async loadManifest(): Promise<Manifest> {
    const raw = await readFileIfExists(this.paths.manifest);
    if (raw === null) return emptyManifest();

    const parsed = parseJson(raw, this.paths.manifest, "the configuration index");
    try {
      return migrateManifest(parsed);
    } catch (error) {
      if (error instanceof SchemaError) {
        throw new ConfigCorruptError(error.message, this.paths.manifest, error);
      }
      throw error;
    }
  }

  async saveManifest(manifest: Manifest): Promise<void> {
    const validated = manifestSchema.parse({ ...manifest, schemaVersion: CURRENT_SCHEMA_VERSION });
    await writeFileAtomic(this.paths.manifest, `${JSON.stringify(validated, null, 2)}\n`, FILE_MODE);
  }

  async list(): Promise<ManifestEntry[]> {
    const manifest = await this.loadManifest();
    return [...manifest.configs].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolves a name the way `--config` does: case-insensitively, by display
   * name. Returns null rather than falling back — the caller decides whether to
   * offer creation (decision §4).
   */
  async findByName(name: string): Promise<ManifestEntry | null> {
    const wanted = nameKey(name);
    const manifest = await this.loadManifest();
    return manifest.configs.find((entry) => nameKey(entry.name) === wanted) ?? null;
  }

  async setActive(id: string | null): Promise<void> {
    const manifest = await this.loadManifest();

    if (id !== null && !manifest.configs.some((entry) => entry.id === id)) {
      throw new ConfigError(`no configuration with id ${id}`);
    }

    await this.saveManifest({ ...manifest, activeConfigId: id });
  }

  async setActiveByName(name: string): Promise<ManifestEntry> {
    const entry = await this.findByName(name);
    if (!entry) throw new ConfigError(`there is no configuration called "${name}"`);
    await this.setActive(entry.id);
    return entry;
  }

  async active(): Promise<ManifestEntry | null> {
    const manifest = await this.loadManifest();
    if (manifest.activeConfigId === null) return null;
    return manifest.configs.find((entry) => entry.id === manifest.activeConfigId) ?? null;
  }

  // ------------------------------------------------------------ config files

  async load(id: string): Promise<TanukiConfig> {
    const file = this.configFile(id);
    const raw = await readFileIfExists(file);
    if (raw === null) throw new ConfigError(`the configuration file for ${id} is missing`);

    const parsed = parseJson(raw, file, "the configuration");
    try {
      return migrateConfig(parsed, id);
    } catch (error) {
      if (error instanceof SchemaError) {
        throw new ConfigCorruptError(error.message, file, error);
      }
      throw error;
    }
  }

  async save(config: TanukiConfig): Promise<TanukiConfig> {
    const stamped: TanukiConfig = { ...config, schemaVersion: CURRENT_SCHEMA_VERSION, updatedAt: this.clock() };
    const validated = configSchema.parse(stamped);
    await writeFileAtomic(this.configFile(validated.id), `${JSON.stringify(validated, null, 2)}\n`, FILE_MODE);
    return validated;
  }

  // -------------------------------------------------------------------- CRUD

  async create(input: CreateConfigInput): Promise<TanukiConfig> {
    const manifest = await this.loadManifest();
    const name = this.requireUniqueName(input.name, manifest.configs);

    const id = randomUUID();
    const mode = input.mode ?? this.stores.preferred;
    const now = this.clock();

    const credential: CredentialRef =
      mode === "keychain" ? { mode: "keychain", ref: id } : { mode: "passphrase", vault: `${id}.json` };

    const config: TanukiConfig = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id,
      name,
      createdAt: now,
      updatedAt: now,
      credential,
      zones: [],
      groups: [],
      prefs: { purgeRate: input.prefs?.purgeRate ?? "auto" },
    };

    await this.save(config);
    await this.saveManifest({
      ...manifest,
      activeConfigId: manifest.activeConfigId ?? id,
      configs: [...manifest.configs, { id, name }],
    });

    return config;
  }

  /**
   * Renaming changes a label and nothing else (decision D3). The file name is
   * the config ID and the keychain account is the config ID, so no file moves
   * and no credential can be orphaned.
   */
  async rename(id: string, newName: string): Promise<TanukiConfig> {
    const manifest = await this.loadManifest();
    if (!manifest.configs.some((entry) => entry.id === id)) {
      throw new ConfigError(`no configuration with id ${id}`);
    }

    const name = this.requireUniqueName(newName, manifest.configs, id);
    const config = await this.load(id);
    const saved = await this.save({ ...config, name });

    await this.saveManifest({
      ...manifest,
      configs: manifest.configs.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
    });

    return saved;
  }

  async updatePrefs(id: string, prefs: Partial<Prefs>): Promise<TanukiConfig> {
    const config = await this.load(id);
    return this.save({ ...config, prefs: { ...config.prefs, ...prefs } });
  }

  /**
   * Removes the configuration, its file and its stored credential. Cloudflare
   * zones and the Cloudflare account are untouched — this is local only.
   */
  async remove(id: string): Promise<void> {
    const manifest = await this.loadManifest();
    const entry = manifest.configs.find((candidate) => candidate.id === id);
    if (!entry) throw new ConfigError(`no configuration with id ${id}`);

    let config: TanukiConfig | null = null;
    try {
      config = await this.load(id);
    } catch {
      // A corrupt file should not block deletion — that is how a user recovers.
    }

    await removeFile(this.configFile(id));

    if (config) {
      const store = storeFor(this.stores, config.credential.mode);
      await store.delete(this.credentialKey(config)).catch(() => {});
    } else {
      await this.stores.keychain.delete(id).catch(() => {});
      await this.stores.passphrase.delete(id).catch(() => {});
    }

    const remaining = manifest.configs.filter((candidate) => candidate.id !== id);
    await this.saveManifest({
      ...manifest,
      activeConfigId: manifest.activeConfigId === id ? (remaining[0]?.id ?? null) : manifest.activeConfigId,
      configs: remaining,
    });
  }

  // -------------------------------------------------------------- credentials

  /** Keychain account key. For passphrase mode the vault is addressed by ID too. */
  private credentialKey(config: TanukiConfig): string {
    return config.credential.mode === "keychain" ? config.credential.ref : config.id;
  }

  async setCredential(id: string, secret: string): Promise<void> {
    const config = await this.load(id);
    const store = storeFor(this.stores, config.credential.mode);
    await store.set(this.credentialKey(config), secret);
  }

  /**
   * Returns null when no credential is stored. Throws
   * CredentialUnavailableError when one exists but cannot be read — the caller
   * renders the "credentials unavailable" state rather than deleting anything
   * (decision S5).
   *
   * A dismissed passphrase prompt travels through untouched: it is an answer,
   * not a broken credential, and dressing it up as one would put a user who
   * pressed escape on an error screen.
   */
  async getCredential(id: string): Promise<string | null> {
    const config = await this.load(id);
    const store = storeFor(this.stores, config.credential.mode);

    try {
      return await store.get(this.credentialKey(config));
    } catch (error) {
      if (error instanceof CredentialUnavailableError || error instanceof PassphraseCancelledError) throw error;
      throw new CredentialUnavailableError(
        `your credential for "${config.name}" could not be read. It may have been removed from ${store.describe()}.`,
        id,
        error,
      );
    }
  }

  async credentialStatus(id: string): Promise<{ present: boolean; mode: CredentialMode; description: string }> {
    const config = await this.load(id);
    const store = storeFor(this.stores, config.credential.mode);
    const secret = await this.getCredential(id).catch(() => null);
    return { present: secret !== null, mode: config.credential.mode, description: store.describe() };
  }

  async describeCredential(id: string): Promise<string> {
    const config = await this.load(id);
    return storeFor(this.stores, config.credential.mode).describe();
  }

  // ------------------------------------------------------------------ helpers

  private requireUniqueName(name: string, peers: readonly ManifestEntry[], exceptId?: string): string {
    const result = validateName(name, "configuration name");
    if (!result.ok) throw new ConfigError(result.reason);

    const key = nameKey(result.name);
    const clash = peers.some((peer) => peer.id !== exceptId && nameKey(peer.name) === key);
    if (clash) throw new ConfigError(`a configuration called "${result.name}" already exists`);

    return result.name;
  }
}

function parseJson(raw: string, path: string, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ConfigCorruptError(`${what} is not a JSON object`, path);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigCorruptError) throw error;
    throw new ConfigCorruptError(`${what} is not valid JSON`, path, error);
  }
}
