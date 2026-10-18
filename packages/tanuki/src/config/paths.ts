/**
 * Filesystem layout (decision D2, D6).
 *
 * Platform config directory, with a manifest plus one file per configuration.
 * `TANUKI_HOME` overrides the root — that exists so tests never touch a real
 * user's configuration, and so a user can keep a tree somewhere explicit.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface TanukiPaths {
  /** Root directory. Mode 0700. */
  root: string;
  /** `config.json` — schema version, config list, active config, global prefs. */
  manifest: string;
  /** Directory of `<configId>.json` files. */
  configsDir: string;
  /** Passphrase-mode vault files, when the keychain is unavailable. */
  vaultsDir: string;
  /** JSONL diagnostics, written only when TANUKI_LOG is set. */
  logsDir: string;
}

export interface ResolvePathsOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

export function resolvePaths(options: ResolvePathsOptions = {}): TanukiPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const root = configRoot(env, platform, home);

  return {
    root,
    manifest: join(root, "config.json"),
    configsDir: join(root, "configs"),
    vaultsDir: join(root, "vaults"),
    logsDir: join(root, "logs"),
  };
}

function configRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const override = env.TANUKI_HOME?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? join(appData, "tanuki") : join(home, "AppData", "Roaming", "tanuki");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "tanuki");
  }

  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, "tanuki") : join(home, ".config", "tanuki");
}
