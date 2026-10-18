/**
 * Passphrase-mode credential store (decision S3).
 *
 * One vault file per credential, under `vaults/`. Used only when no OS
 * credential store is available, or when the user opts out of it at creation
 * (decision S4).
 *
 * Two rules make this usable rather than merely correct:
 *
 *  - **The passphrase is asked for, not invented.** The store has no UI, so it
 *    calls the injected `prompt` for one. A dismissed prompt comes back as
 *    `null` and becomes `PassphraseCancelledError`, which callers treat as "put
 *    the user back", never as a failure (see `secrets/types.ts`).
 *  - **The passphrase is cached in memory for the session** after a successful
 *    unlock. Prompting on every read would make the fallback unusable, and the
 *    cached value is no more exposed than the keychain entry it stands in for.
 *
 * A wrong passphrase is the one vault failure worth retrying, so the prompt is
 * repeated — with the failure carried in the context so the interface can show
 * it — until one opens the vault or the user gives up. Any other vault error is
 * unreadable straight away; asking again cannot fix a mangled file.
 *
 * Replacing a token does **not** re-key the vault: an existing vault is
 * unlocked with its current passphrase and re-sealed with the same one. Asking
 * for a new passphrase there would silently change the thing protecting the
 * token at the moment the user asked to change only the token.
 */
import { join } from "node:path";
import { open as openVault, seal, DEFAULT_KDF, isVault, VaultDecryptError } from "./crypto.ts";
import type { KdfParams, Vault } from "./crypto.ts";
import { readFileIfExists, removeFile, writeFileAtomic, FILE_MODE } from "../config/storage.ts";
import {
  CredentialDecryptError,
  PassphraseCancelledError,
  type CredentialMode,
  type CredentialStore,
} from "./types.ts";

export interface PassphrasePromptContext {
  id: string;
  reason: "unlock" | "create";
  /**
   * Set when a previous attempt at the *same* vault was rejected, so the prompt
   * can say what went wrong rather than silently asking again.
   */
  error?: string;
}

/**
 * Returns the passphrase, or `null` when the user dismissed the prompt.
 *
 * `null` rather than a thrown error because "the user changed their mind" is a
 * normal outcome of asking a question, not an exception in the mechanism.
 */
export type PassphrasePrompt = (context: PassphrasePromptContext) => Promise<string | null>;

export interface PassphraseStoreOptions {
  vaultsDir: string;
  prompt: PassphrasePrompt;
  kdf?: KdfParams;
}

/** One sentence, used verbatim wherever a retry follows a failed attempt. */
export const WRONG_PASSPHRASE = "That passphrase did not unlock this vault.";

export function createPassphraseStore(options: PassphraseStoreOptions): CredentialStore {
  const { vaultsDir, prompt } = options;
  const kdf = options.kdf ?? DEFAULT_KDF;
  const unlocked = new Map<string, string>();

  const vaultFile = (id: string) => join(vaultsDir, `${id}.json`);

  return {
    mode: "passphrase" satisfies CredentialMode,

    describe() {
      return (
        "an encrypted file unlocked with your passphrase " +
        `(AES-256-GCM, key derived with scrypt at N=2^${Math.log2(kdf.N)})`
      );
    },

    async isAvailable() {
      // Always usable: it needs nothing from the operating system.
      return true;
    },

    async get(id) {
      const raw = await readFileIfExists(vaultFile(id));
      if (raw === null) return null;

      const vault = parseVault(raw, id);

      const cached = unlocked.get(id);
      if (cached !== undefined) {
        try {
          return await openVault(cached, vault);
        } catch (error) {
          // The cached passphrase is no longer the vault's: drop it and make the
          // caller ask again rather than repeating a guess that cannot work.
          unlocked.delete(id);
          throw decryptFailure(id, error);
        }
      }

      return askUntilAccepted(id, "unlock", async (passphrase) => {
        const secret = await openVault(passphrase, vault);
        unlocked.set(id, passphrase);
        return secret;
      });
    },

    async set(id, secret) {
      const existing = await readFileIfExists(vaultFile(id));
      const passphrase =
        unlocked.get(id) ??
        (existing === null
          ? await requirePassphrase({ id, reason: "create" })
          : await askUntilAccepted(id, "unlock", async (candidate) => {
              // Proving the passphrase before sealing is what keeps a failed
              // attempt from overwriting a vault with a key the user did not
              // mean to choose.
              await openVault(candidate, parseVault(existing, id));
              return candidate;
            }));

      const vault = await seal(passphrase, secret, kdf);
      await writeFileAtomic(vaultFile(id), JSON.stringify(vault, null, 2), FILE_MODE);
      unlocked.set(id, passphrase);
    },

    async delete(id) {
      unlocked.delete(id);
      await removeFile(vaultFile(id));
    },
  };

  /**
   * Asks for a passphrase until `attempt` accepts one, or the user gives up.
   *
   * Only an authentication failure is retried. A vault that is structurally
   * broken — the wrong IV length, say — is unreadable however many times it is
   * asked about, so it is reported rather than looped on.
   */
  async function askUntilAccepted<T>(
    id: string,
    reason: PassphrasePromptContext["reason"],
    attempt: (passphrase: string) => Promise<T>,
  ): Promise<T> {
    let error: string | undefined;

    for (;;) {
      const context: PassphrasePromptContext = error === undefined ? { id, reason } : { id, reason, error };
      const passphrase = await requirePassphrase(context);

      try {
        return await attempt(passphrase);
      } catch (cause) {
        if (!(cause instanceof VaultDecryptError)) throw decryptFailure(id, cause);
        error = WRONG_PASSPHRASE;
      }
    }
  }

  async function requirePassphrase(context: PassphrasePromptContext): Promise<string> {
    const passphrase = await prompt(context);
    if (passphrase === null) throw new PassphraseCancelledError(context.id);
    // An empty answer is a dismissal that arrived by a different route: there is
    // no such thing as an empty passphrase, so it cannot be taken literally.
    if (passphrase.length === 0) throw new PassphraseCancelledError(context.id);
    return passphrase;
  }
}

function parseVault(raw: string, id: string): Vault {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CredentialDecryptError("the credential vault is not valid JSON", id, error);
  }
  if (!isVault(parsed)) {
    throw new CredentialDecryptError("the credential vault has an unrecognised format", id);
  }
  return parsed;
}

function decryptFailure(id: string, cause: unknown): CredentialDecryptError {
  return cause instanceof CredentialDecryptError
    ? cause
    : new CredentialDecryptError("could not decrypt your credential with that passphrase", id, cause);
}
