import { beforeEach, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigCorruptError, ConfigError, ConfigManager } from "../src/config/manager.ts";
import type { TanukiPaths } from "../src/config/paths.ts";
import { fakeStores } from "./helpers.ts";
import { tempPaths } from "./helpers.ts";

let paths: TanukiPaths;
let manager: ConfigManager;

beforeEach(async () => {
  paths = await tempPaths();
  manager = new ConfigManager(paths, fakeStores());
});

describe("configuration lifecycle", () => {
  test("creates a config, its file and its manifest entry", async () => {
    const config = await manager.create({ name: "client" });

    expect(config.name).toBe("client");
    expect(config.zones).toEqual([]);
    expect(config.groups).toEqual([]);
    expect(config.credential).toEqual({ mode: "keychain", ref: config.id });

    const listed = await manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("client");

    const manifest = await manager.loadManifest();
    expect(manifest.activeConfigId).toBe(config.id);
  });

  test("looks up by name case-insensitively", async () => {
    await manager.create({ name: "Client" });
    expect(await manager.findByName("client")).not.toBeNull();
    expect(await manager.findByName("CLIENT")).not.toBeNull();
    expect(await manager.findByName("production")).toBeNull();
  });

  test("refuses a duplicate name, case-insensitively", async () => {
    await manager.create({ name: "client" });
    await expect(manager.create({ name: "Client" })).rejects.toThrow(/already exists/);
  });

  test("renames without moving the file or orphaning the credential", async () => {
    const config = await manager.create({ name: "client" });
    const fileBefore = join(paths.configsDir, `${config.id}.json`);

    const renamed = await manager.rename(config.id, "production");

    expect(renamed.id).toBe(config.id);
    expect(renamed.name).toBe("production");
    expect(renamed.credential).toEqual(config.credential);

    // Same path, still readable, and the manifest agrees.
    expect(await stat(fileBefore)).toBeTruthy();
    expect((await manager.load(config.id)).name).toBe("production");
    expect((await manager.list())[0]!.name).toBe("production");
  });

  test("stores the credential outside the configuration file", async () => {
    const stores = fakeStores();
    const isolated = new ConfigManager(paths, stores);
    const config = await isolated.create({ name: "client" });

    await isolated.setCredential(config.id, "cfut_supersecrettokenvalue");

    const onDisk = await readFile(join(paths.configsDir, `${config.id}.json`), "utf8");
    expect(onDisk).not.toContain("cfut_supersecrettokenvalue");
    expect(stores.keychain.values.get(config.id)).toBe("cfut_supersecrettokenvalue");

    expect(await isolated.getCredential(config.id)).toBe("cfut_supersecrettokenvalue");
  });

  test("deleting removes the file, the manifest entry and the credential", async () => {
    const stores = fakeStores();
    const isolated = new ConfigManager(paths, stores);
    const config = await isolated.create({ name: "client" });
    await isolated.setCredential(config.id, "cfut_supersecrettokenvalue");

    await isolated.remove(config.id);

    expect(await isolated.list()).toEqual([]);
    expect(stores.keychain.values.has(config.id)).toBe(false);
    await expect(stat(join(paths.configsDir, `${config.id}.json`))).rejects.toThrow();
  });

  test("deleting the active config moves the active pointer", async () => {
    const first = await manager.create({ name: "one" });
    const second = await manager.create({ name: "two" });
    await manager.setActive(first.id);

    await manager.remove(first.id);

    const manifest = await manager.loadManifest();
    expect(manifest.activeConfigId).toBe(second.id);
  });

  test("a renaming collision is refused", async () => {
    await manager.create({ name: "one" });
    const second = await manager.create({ name: "two" });
    await expect(manager.rename(second.id, "ONE")).rejects.toThrow(/already exists/);
  });

  test("updating prefs persists only the prefs", async () => {
    const config = await manager.create({ name: "client" });
    const updated = await manager.updatePrefs(config.id, { purgeRate: "conservative" });
    expect(updated.prefs.purgeRate).toBe("conservative");
    expect((await manager.load(config.id)).prefs.purgeRate).toBe("conservative");
  });

  test("unknown ids are an error, not a silent no-op", async () => {
    await expect(manager.load("nope")).rejects.toThrow(ConfigError);
    await manager.create({ name: "client" });
    await expect(manager.rename("nope", "x")).rejects.toThrow(ConfigError);
  });
});

describe("storage safety", () => {
  test("config files are 0600 and the directory is 0700", async () => {
    const config = await manager.create({ name: "client" });

    const fileMode = (await stat(join(paths.configsDir, `${config.id}.json`))).mode & 0o777;
    const dirMode = (await stat(paths.configsDir)).mode & 0o777;
    const rootMode = (await stat(paths.root)).mode & 0o777;

    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
    expect(rootMode).toBe(0o700);
  });

  test("a corrupt file is reported, never silently discarded", async () => {
    const config = await manager.create({ name: "client" });
    await writeFile(join(paths.configsDir, `${config.id}.json`), "{ not json", "utf8");

    await expect(manager.load(config.id)).rejects.toThrow(ConfigCorruptError);
  });

  test("a file from a newer Tanuki is refused with an upgrade message", async () => {
    const config = await manager.create({ name: "client" });
    const raw = JSON.parse(await readFile(join(paths.configsDir, `${config.id}.json`), "utf8"));
    raw.schemaVersion = 99;
    await writeFile(join(paths.configsDir, `${config.id}.json`), JSON.stringify(raw), "utf8");

    await expect(manager.load(config.id)).rejects.toThrow(/newer version of Tanuki/);
  });

  test("a corrupt index is reported rather than replaced", async () => {
    await manager.create({ name: "client" });
    await writeFile(paths.manifest, "not json at all", "utf8");
    await expect(manager.loadManifest()).rejects.toThrow(ConfigCorruptError);
  });

  test("a missing filesystem reads as an empty workspace, not an error", async () => {
    expect(await manager.loadManifest()).toEqual({
      schemaVersion: 1,
      activeConfigId: null,
      configs: [],
      prefs: { purgeRate: "auto" },
    });
  });

  test("writes are atomic — no temporary files are left behind", async () => {
    await manager.create({ name: "client" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(paths.configsDir);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});
