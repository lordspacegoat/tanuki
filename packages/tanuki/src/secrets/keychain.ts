/**
 * OS credential store adapters (decision S1).
 *
 * Shelling out to the platform's own tool rather than linking a native module
 * keeps the app free of native dependencies, which is what makes the compiled
 * per-platform binary the only native artefact we ship.
 *
 * Known limitation, documented in SECURITY.md: `security add-generic-password`
 * takes the secret as an argument, so it is briefly visible to a same-user `ps`.
 */
import { spawn } from "node:child_process";
import { KEYCHAIN_SERVICE } from "./types.ts";

export interface KeychainBackend {
  /** Human-readable name for onboarding copy (decision S6). */
  readonly label: string;
  isAvailable(): Promise<boolean>;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** macOS Keychain, via the `security` tool that ships with the OS. */
function macosBackend(): KeychainBackend {
  const common = ["-s", KEYCHAIN_SERVICE];
  // errSecItemNotFound.
  const NOT_FOUND = 44;

  return {
    label: "the macOS Keychain",
    async isAvailable() {
      try {
        const result = await run("security", ["-h"]);
        // `security -h` exits non-zero but proves the binary exists.
        return result.stdout.includes("find-generic-password") || result.stderr.includes("find-generic-password");
      } catch {
        return false;
      }
    },
    async get(account) {
      const result = await run("security", ["find-generic-password", ...common, "-a", account, "-w"]);
      if (result.code === NOT_FOUND) return null;
      if (result.code !== 0) throw new Error(`security find-generic-password failed: ${result.stderr.trim()}`);
      return result.stdout.replace(/\n$/, "");
    },
    async set(account, secret) {
      const result = await run("security", ["add-generic-password", "-U", ...common, "-a", account, "-w", secret]);
      if (result.code !== 0) throw new Error(`security add-generic-password failed: ${result.stderr.trim()}`);
    },
    async remove(account) {
      const result = await run("security", ["delete-generic-password", ...common, "-a", account]);
      if (result.code !== 0 && result.code !== NOT_FOUND) {
        throw new Error(`security delete-generic-password failed: ${result.stderr.trim()}`);
      }
    },
  };
}

/** Linux, via libsecret's `secret-tool`. Needs a running keyring and DBus. */
function linuxBackend(): KeychainBackend {
  const attrs = ["service", KEYCHAIN_SERVICE];

  return {
    label: "libsecret (your desktop keyring)",
    async isAvailable() {
      try {
        const result = await run("secret-tool", ["--version"]);
        return result.code === 0;
      } catch {
        return false;
      }
    },
    async get(account) {
      const result = await run("secret-tool", ["lookup", ...attrs, "account", account]);
      if (result.code !== 0) return null;
      const value = result.stdout.replace(/\n$/, "");
      return value.length === 0 ? null : value;
    },
    async set(account, secret) {
      // The secret goes over stdin, never as an argument.
      const result = await run(
        "secret-tool",
        ["store", "--label", `Tanuki (${account})`, ...attrs, "account", account],
        secret,
      );
      if (result.code !== 0) throw new Error(`secret-tool store failed: ${result.stderr.trim()}`);
    },
    async remove(account) {
      await run("secret-tool", ["clear", ...attrs, "account", account]);
    },
  };
}

/**
 * Windows Credential Manager. Best-effort and explicitly non-gating
 * (decision F8): reading back a stored credential needs the third-party
 * CredentialManager PowerShell module, which is not part of Windows. Where it
 * is missing, `isAvailable()` returns false and Tanuki falls back to
 * passphrase mode rather than pretending.
 */
function windowsBackend(): KeychainBackend {
  const powershell = (script: string) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const target = (account: string) => `${KEYCHAIN_SERVICE}:${account}`;

  return {
    label: "Windows Credential Manager",
    async isAvailable() {
      try {
        const result = await powershell("if (Get-Module -ListAvailable -Name CredentialManager) { 'yes' }");
        return result.stdout.trim() === "yes";
      } catch {
        return false;
      }
    },
    async get(account) {
      const result = await powershell(
        `(Get-StoredCredential -Target '${target(account)}').GetNetworkCredential().Password`,
      );
      if (result.code !== 0) return null;
      const value = result.stdout.trim();
      return value.length === 0 ? null : value;
    },
    async set(account, secret) {
      const result = await powershell(
        `New-StoredCredential -Target '${target(account)}' -UserName '${KEYCHAIN_SERVICE}' -Password '${secret.replace(/'/g, "''")}' -Persist LocalMachine | Out-Null`,
      );
      if (result.code !== 0) throw new Error(`New-StoredCredential failed: ${result.stderr.trim()}`);
    },
    async remove(account) {
      await powershell(`Remove-StoredCredential -Target '${target(account)}'`);
    },
  };
}

/**
 * A backend that is never available. Used on platforms with no adapter so the
 * caller cleanly falls through to passphrase mode.
 */
function unavailableBackend(why: string): KeychainBackend {
  return {
    label: why,
    async isAvailable() {
      return false;
    },
    async get() {
      return null;
    },
    async set() {
      throw new Error(why);
    },
    async remove() {},
  };
}

export function keychainBackend(platform: NodeJS.Platform = process.platform): KeychainBackend {
  switch (platform) {
    case "darwin":
      return macosBackend();
    case "linux":
      return linuxBackend();
    case "win32":
      return windowsBackend();
    default:
      return unavailableBackend(`no credential store adapter for ${platform}`);
  }
}
