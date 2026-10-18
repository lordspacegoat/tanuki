import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/config/paths.ts";
import type { TanukiPaths } from "../src/config/paths.ts";
import type { CredentialStores } from "../src/secrets/store.ts";
import type { CredentialStore } from "../src/secrets/types.ts";

export async function tempPaths(prefix = "tanuki-test-"): Promise<TanukiPaths> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  return resolvePaths({ env: { TANUKI_HOME: home }, platform: "linux", home });
}

export type MemoryStore = CredentialStore & { values: Map<string, string> };

export interface FakeStores extends CredentialStores {
  keychain: MemoryStore;
  passphrase: MemoryStore;
}

export function memoryStore(mode: "keychain" | "passphrase"): MemoryStore {
  const values = new Map<string, string>();
  return {
    mode,
    values,
    describe: () => (mode === "keychain" ? "an in-memory test keychain" : "an in-memory test vault"),
    isAvailable: async () => true,
    get: async (id) => values.get(id) ?? null,
    set: async (id, secret) => {
      values.set(id, secret);
    },
    delete: async (id) => {
      values.delete(id);
    },
  };
}

export function fakeStores(): FakeStores {
  const keychain = memoryStore("keychain");
  const passphrase = memoryStore("passphrase");
  return {
    keychain,
    passphrase,
    preferred: "keychain",
    keychainAvailable: true,
    keychainLabel: "an in-memory test keychain",
  };
}
