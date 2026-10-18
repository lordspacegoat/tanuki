import { describe, expect, test } from "bun:test";
import { resolvePaths } from "../src/config/paths.ts";

describe("resolvePaths", () => {
  test("uses the platform config directory", () => {
    const darwin = resolvePaths({ env: {}, platform: "darwin", home: "/Users/ada" });
    expect(darwin.root).toBe("/Users/ada/Library/Application Support/tanuki");

    const linux = resolvePaths({ env: {}, platform: "linux", home: "/home/ada" });
    expect(linux.root).toBe("/home/ada/.config/tanuki");

    const windows = resolvePaths({ env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }, platform: "win32", home: "C:\\Users\\ada" });
    expect(windows.root).toBe("C:\\Users\\ada\\AppData\\Roaming/tanuki");
  });

  test("honours XDG_CONFIG_HOME on Linux", () => {
    const paths = resolvePaths({ env: { XDG_CONFIG_HOME: "/srv/xdg" }, platform: "linux", home: "/home/ada" });
    expect(paths.root).toBe("/srv/xdg/tanuki");
  });

  test("TANUKI_HOME overrides everything, which is how tests stay isolated", () => {
    const paths = resolvePaths({ env: { TANUKI_HOME: "/tmp/tanuki-isolated" }, platform: "darwin", home: "/Users/ada" });
    expect(paths.root).toBe("/tmp/tanuki-isolated");
    expect(paths.manifest).toBe("/tmp/tanuki-isolated/config.json");
    expect(paths.configsDir).toBe("/tmp/tanuki-isolated/configs");
  });

  test("derives every path from the root", () => {
    const paths = resolvePaths({ env: {}, platform: "linux", home: "/home/ada" });
    expect(paths.manifest.startsWith(paths.root)).toBe(true);
    expect(paths.configsDir.startsWith(paths.root)).toBe(true);
    expect(paths.vaultsDir.startsWith(paths.root)).toBe(true);
    expect(paths.logsDir.startsWith(paths.root)).toBe(true);
  });
});
