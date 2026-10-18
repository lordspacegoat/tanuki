/**
 * Credential store selection (decisions S1, S4, S6).
 *
 * Both stores are constructed once. Which one a given configuration uses is
 * recorded in the configuration itself, so a config created in passphrase mode
 * stays in passphrase mode even on a machine that has a keychain.
 */
import { keychainBackend } from "./keychain.ts";
import type { KeychainBackend } from "./keychain.ts";
import { createPassphraseStore } from "./passphrase.ts";
import type { PassphrasePrompt } from "./passphrase.ts";
import type { CredentialMode, CredentialStore } from "./types.ts";
import type { TanukiPaths } from "../config/paths.ts";
import type { KdfParams } from "./crypto.ts";

export interface CredentialStores {
  keychain: CredentialStore;
  passphrase: CredentialStore;
  /** What a new configuration should use (decision S4). */
  preferred: CredentialMode;
  /** Whether the keychain is genuinely usable right now (decision S6). */
  keychainAvailable: boolean;
  /** Name of the mechanism actually detected, for onboarding copy. */
  keychainLabel: string;
}

export interface CreateStoresOptions {
  paths: TanukiPaths;
  prompt: PassphrasePrompt;
  platform?: NodeJS.Platform;
  backend?: KeychainBackend;
  kdf?: KdfParams;
}

export async function createCredentialStores(options: CreateStoresOptions): Promise<CredentialStores> {
  const backend = options.backend ?? keychainBackend(options.platform);
  const keychain = createKeychainStore(backend);
  const passphrase = createPassphraseStore({
    vaultsDir: options.paths.vaultsDir,
    prompt: options.prompt,
    ...(options.kdf ? { kdf: options.kdf } : {}),
  });

  let keychainAvailable = false;
  try {
    keychainAvailable = await backend.isAvailable();
  } catch {
    keychainAvailable = false;
  }

  return {
    keychain,
    passphrase,
    preferred: keychainAvailable ? "keychain" : "passphrase",
    keychainAvailable,
    keychainLabel: backend.label,
  };
}

export function storeFor(stores: CredentialStores, mode: CredentialMode): CredentialStore {
  return mode === "keychain" ? stores.keychain : stores.passphrase;
}

export function createKeychainStore(backend: KeychainBackend): CredentialStore {
  return {
    mode: "keychain",

    describe() {
      return `${backend.label}, via the operating system's own tool`;
    },

    isAvailable() {
      return backend.isAvailable();
    },

    get(account) {
      return backend.get(account);
    },

    set(account, secret) {
      return backend.set(account, secret);
    },

    delete(account) {
      return backend.remove(account);
    },
  };
}
