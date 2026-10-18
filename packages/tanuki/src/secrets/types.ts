/**
 * The credential store seam (decisions S1–S5).
 *
 * The UI and the configuration manager only ever see this interface. Which
 * mechanism is behind it — the macOS Keychain, libsecret through `secret-tool`,
 * Windows Credential Manager, or a passphrase-encrypted file — is decided once,
 * at start-up, and never leaks further in.
 */
export type CredentialMode = "keychain" | "passphrase";

export interface CredentialStore {
  readonly mode: CredentialMode;

  /**
   * Human-readable description of the mechanism actually in use. Onboarding
   * copy names this verbatim (decision S6) so the explanation cannot drift from
   * reality.
   */
  describe(): string;

  isAvailable(): Promise<boolean>;

  /** Returns null when no credential is stored. Throws when access is denied. */
  get(id: string): Promise<string | null>;

  set(id: string, secret: string): Promise<void>;

  delete(id: string): Promise<void>;
}

/** Raised when a credential exists but cannot be read — decision S5. */
export class CredentialUnavailableError extends Error {
  constructor(
    message: string,
    readonly id: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CredentialUnavailableError";
  }
}

/** Raised when a stored secret cannot be decrypted (wrong passphrase/corrupt). */
export class CredentialDecryptError extends Error {
  constructor(
    message: string,
    readonly id: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CredentialDecryptError";
  }
}

/**
 * Raised when the user dismisses a passphrase prompt.
 *
 * This is not a failure state and must not be reported as one: nothing was
 * read, written or changed, and the caller's job is to put the user back where
 * they were. It is a distinct type precisely so it cannot be mistaken for the
 * "credentials unavailable" case (decision S5), which does need to be stated.
 */
export class PassphraseCancelledError extends Error {
  constructor(readonly id: string) {
    super("the passphrase prompt was dismissed");
    this.name = "PassphraseCancelledError";
  }
}

export const KEYCHAIN_SERVICE = "tanuki";
