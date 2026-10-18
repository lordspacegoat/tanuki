import { describe, expect, test } from "bun:test";
import { FAST_KDF_FOR_TESTS, isVault, open, seal } from "../src/secrets/crypto.ts";
import { DEFAULT_KDF } from "../src/secrets/crypto.ts";

const PASSPHRASE = "correct horse battery staple";

describe("scrypt + AES-256-GCM vault", () => {
  test("round-trips a secret", async () => {
    const vault = await seal(PASSPHRASE, "cfut_secret_token", FAST_KDF_FOR_TESTS);
    expect(await open(PASSPHRASE, vault)).toBe("cfut_secret_token");
  });

  test("never stores the plaintext", async () => {
    const vault = await seal(PASSPHRASE, "cfut_secret_token", FAST_KDF_FOR_TESTS);
    expect(JSON.stringify(vault)).not.toContain("cfut_secret_token");
    expect(Buffer.from(vault.ct, "base64").toString("utf8")).not.toContain("cfut");
  });

  test("a wrong passphrase fails authentication rather than returning garbage", async () => {
    const vault = await seal(PASSPHRASE, "cfut_secret_token", FAST_KDF_FOR_TESTS);
    await expect(open("wrong passphrase", vault)).rejects.toThrow(/could not decrypt/);
  });

  test("tampering with the ciphertext is detected", async () => {
    const vault = await seal(PASSPHRASE, "cfut_secret_token", FAST_KDF_FOR_TESTS);
    const bytes = Buffer.from(vault.ct, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    await expect(open(PASSPHRASE, { ...vault, ct: bytes.toString("base64") })).rejects.toThrow(/could not decrypt/);
  });

  test("a unique salt is used for every seal", async () => {
    const first = await seal(PASSPHRASE, "same", FAST_KDF_FOR_TESTS);
    const second = await seal(PASSPHRASE, "same", FAST_KDF_FOR_TESTS);
    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(first.ct).not.toBe(second.ct);
  });

  test("records the KDF parameters so a vault stays openable if defaults change", async () => {
    const vault = await seal(PASSPHRASE, "x", FAST_KDF_FOR_TESTS);
    expect(vault.kdf).toMatchObject({ name: "scrypt" });
    expect(vault.kdf.N).toBe(FAST_KDF_FOR_TESTS.N);
  });

  test("refuses an empty passphrase", async () => {
    await expect(seal("", "x", FAST_KDF_FOR_TESTS)).rejects.toThrow(/cannot be empty/);
  });

  test("the production parameters are the documented ones", () => {
    // Changing these is a deliberate, reviewable act — not an accident.
    expect(DEFAULT_KDF).toEqual({ N: 131072, r: 8, p: 1 });
  });

  test("isVault rejects anything that is not a vault", () => {
    expect(isVault(null)).toBe(false);
    expect(isVault({})).toBe(false);
    expect(isVault({ v: 1, ct: "x" })).toBe(false);
  });
});
