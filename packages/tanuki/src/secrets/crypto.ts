/**
 * Passphrase-mode encryption (decision S3).
 *
 * scrypt + AES-256-GCM. scrypt rather than Argon2id because Argon2 needs a
 * native dependency, which contradicts the no-native-modules stance that makes
 * the keychain path portable in the first place. The spec allows either.
 *
 * This is the fallback path. The default is the OS credential store, which
 * involves no cryptography at all on our side.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP's interactive-login recommendation for scrypt. */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

/** Deliberately tiny, for tests that must not take a second each. */
export const FAST_KDF_FOR_TESTS: KdfParams = { N: 2 ** 10, r: 8, p: 1 };

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Vault {
  v: 1;
  kdf: KdfParams & { name: "scrypt"; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  /** Base64 ciphertext. */
  ct: string;
}

export class VaultError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * The ciphertext did not authenticate. In practice this means a wrong
 * passphrase (GCM checks the tag, so a wrong key fails rather than returning
 * plausible garbage), or a file that has been altered.
 *
 * It is a distinct type because it is the one vault failure worth *retrying*:
 * the store asks for the passphrase again only for this, and treats a malformed
 * vault — a wrong IV length, say — as unreadable rather than as a bad guess.
 */
export class VaultDecryptError extends VaultError {
  constructor(message: string, override readonly cause?: unknown) {
    super(message, cause);
    this.name = "VaultDecryptError";
  }
}

function maxmem(params: KdfParams): number {
  // scrypt refuses to allocate if 128 * N * r exceeds maxmem. Give it headroom
  // so a legitimate parameter set is never rejected for being at the boundary.
  return 256 * params.N * params.r;
}

async function deriveKey(passphrase: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  if (passphrase.length === 0) throw new VaultError("the passphrase cannot be empty");
  return scrypt(passphrase.normalize("NFKC"), salt, KEY_BYTES, { ...params, maxmem: maxmem(params) });
}

export async function seal(passphrase: string, plaintext: string, params: KdfParams = DEFAULT_KDF): Promise<Vault> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, params);

  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: 1,
      kdf: { name: "scrypt", ...params, salt: salt.toString("base64") },
      cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: tag.toString("base64") },
      ct: ct.toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Throws VaultError on a wrong passphrase or a tampered file. GCM authenticates,
 * so a wrong key fails the tag check rather than returning plausible garbage.
 */
export async function open(passphrase: string, vault: Vault): Promise<string> {
  const salt = Buffer.from(vault.kdf.salt, "base64");
  const iv = Buffer.from(vault.cipher.iv, "base64");
  const tag = Buffer.from(vault.cipher.tag, "base64");

  if (iv.length !== IV_BYTES) throw new VaultError("the vault's IV is the wrong length");
  if (tag.length !== TAG_BYTES) throw new VaultError("the vault's authentication tag is the wrong length");

  const key = await deriveKey(passphrase, salt, {
    N: vault.kdf.N,
    r: vault.kdf.r,
    p: vault.kdf.p,
  });

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(vault.ct, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new VaultDecryptError("could not decrypt the vault — wrong passphrase, or the file has been altered", error);
  } finally {
    key.fill(0);
  }
}

export function isVault(value: unknown): value is Vault {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Vault>;
  return (
    candidate.v === 1 &&
    typeof candidate.ct === "string" &&
    typeof candidate.kdf === "object" &&
    candidate.kdf !== null &&
    (candidate.kdf as { name?: unknown }).name === "scrypt" &&
    typeof candidate.cipher === "object" &&
    candidate.cipher !== null &&
    (candidate.cipher as { name?: unknown }).name === "aes-256-gcm"
  );
}
