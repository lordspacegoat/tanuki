/**
 * The passphrase credential store, driven by a scripted prompt.
 *
 * The store is the only place that knows whether a vault can be opened, so this
 * is where "ask again", "stop asking" and "do not re-key the file" are pinned.
 * No UI is involved: the prompt is a function, which is the whole point of the
 * seam — the same store serves a real terminal and this test.
 *
 * Several tests build a second store over the *same* directory. That is what a
 * later session looks like, and it is the only way to see whether a passphrase
 * was remembered on disk or merely in memory.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { FAST_KDF_FOR_TESTS, open as openVault } from "../src/secrets/crypto.ts";
import type { Vault } from "../src/secrets/crypto.ts";
import { createPassphraseStore, WRONG_PASSPHRASE } from "../src/secrets/passphrase.ts";
import type { PassphrasePromptContext } from "../src/secrets/passphrase.ts";
import { CredentialDecryptError, PassphraseCancelledError } from "../src/secrets/types.ts";
import { writeFileAtomic, FILE_MODE } from "../src/config/storage.ts";
import type { TanukiPaths } from "../src/config/paths.ts";
import { tempPaths } from "./helpers.ts";

const PASSPHRASE = "correct horse battery staple";

/** A prompt that answers from a list and records every question it was asked. */
function scripted(...answers: Array<string | null>) {
  const seen: PassphrasePromptContext[] = [];
  const prompt = async (context: PassphrasePromptContext): Promise<string | null> => {
    seen.push(context);
    const next = answers.shift();
    if (next === undefined) {
      throw new Error(`the prompt was asked more times than the script allows: ${JSON.stringify(context)}`);
    }
    return next;
  };
  return { prompt, seen };
}

/** A store over `paths` (a fresh temporary tree when none is given). */
async function store(answers: Array<string | null>, paths?: TanukiPaths) {
  const resolved = paths ?? (await tempPaths());
  const script = scripted(...answers);
  const vault = createPassphraseStore({
    vaultsDir: resolved.vaultsDir,
    prompt: script.prompt,
    kdf: FAST_KDF_FOR_TESTS,
  });
  return { paths: resolved, vault, ...script };
}

const vaultFile = (paths: TanukiPaths, id: string) => join(paths.vaultsDir, `${id}.json`);

describe("reading", () => {
  test("no vault means no credential and no question", async () => {
    const { vault, seen } = await store([]);
    expect(await vault.get("c1")).toBeNull();
    expect(seen).toHaveLength(0);
  });

  test("a fresh store asks for the passphrase, and a wrong one is asked again", async () => {
    const first = await store([PASSPHRASE]);
    await first.vault.set("c1", "cfut_test_token_value");

    // A second store over the same directory stands in for a later session:
    // nothing is cached, so the passphrase comes from disk or not at all.
    const second = await store(["not it", PASSPHRASE], first.paths);
    expect(await second.vault.get("c1")).toBe("cfut_test_token_value");

    expect(second.seen).toHaveLength(2);
    expect(second.seen[0]!.reason).toBe("unlock");
    // The first question carries no blame; the second says what went wrong, so
    // the interface has something to show rather than silently asking again.
    expect(second.seen[0]!.error).toBeUndefined();
    expect(second.seen[1]!.error).toBe(WRONG_PASSPHRASE);
  });

  test("a cached passphrase is not asked for twice", async () => {
    const { vault, seen } = await store(["first", "second"]);
    await vault.set("c1", "one");
    expect(await vault.get("c1")).toBe("one");
    await vault.set("c1", "two");
    expect(await vault.get("c1")).toBe("two");
    // One question: the first write. Everything after it reuses the passphrase
    // the vault was opened with.
    expect(seen).toHaveLength(1);
  });
});

describe("cancelling", () => {
  test("a dismissed prompt is a cancellation, not a failure", async () => {
    const first = await store([PASSPHRASE]);
    await first.vault.set("c1", "cfut_test_token_value");

    const second = await store([null], first.paths);
    await expect(second.vault.get("c1")).rejects.toBeInstanceOf(PassphraseCancelledError);
  });

  test("an empty answer is treated as a dismissal", async () => {
    const first = await store([PASSPHRASE]);
    await first.vault.set("c1", "cfut_test_token_value");

    const second = await store([""], first.paths);
    await expect(second.vault.get("c1")).rejects.toBeInstanceOf(PassphraseCancelledError);
  });

  test("dismissing the prompt for a new vault writes nothing", async () => {
    const { paths, vault, seen } = await store([null]);
    await expect(vault.set("c1", "cfut_test_token_value")).rejects.toBeInstanceOf(PassphraseCancelledError);

    // Asked once, answered never — and there is no vault to show for it.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe("create");
    await expect(readFile(vaultFile(paths, "c1"), "utf8")).rejects.toThrow();
  });
});

describe("replacing a token", () => {
  test("keeps the vault's existing passphrase instead of re-keying it", async () => {
    const first = await store([PASSPHRASE]);
    await first.vault.set("c1", "cfut_first_token_value");

    // A later session replaces the token. It must be asked to *unlock*, not to
    // choose again: the user asked to change a token, not a passphrase.
    const second = await store([PASSPHRASE], first.paths);
    await second.vault.set("c1", "cfut_second_token_value");
    expect(second.seen).toHaveLength(1);
    expect(second.seen[0]!.reason).toBe("unlock");

    const third = await store([PASSPHRASE], first.paths);
    expect(await third.vault.get("c1")).toBe("cfut_second_token_value");
  });
});

describe("the vault on disk", () => {
  test("holds no readable token, and is unreadable without the passphrase", async () => {
    const { paths, vault } = await store([PASSPHRASE]);
    await vault.set("c1", "cfut_test_token_value");

    const raw = await readFile(vaultFile(paths, "c1"), "utf8");
    expect(raw).not.toContain("cfut_test_token_value");
    expect(raw).not.toContain(PASSPHRASE);

    const parsed = JSON.parse(raw) as Vault;
    await expect(openVault("wrong", parsed)).rejects.toThrow(/could not decrypt/);
    expect(await openVault(PASSPHRASE, parsed)).toBe("cfut_test_token_value");
  });

  test("a malformed vault is reported rather than asked about forever", async () => {
    const { paths, vault, seen } = await store([PASSPHRASE]);

    // Structurally a vault, but the IV can never be right. Asking for the
    // passphrase again cannot fix it, so it must not be retried.
    await writeFileAtomic(
      vaultFile(paths, "c1"),
      JSON.stringify({
        v: 1,
        kdf: { name: "scrypt", N: 1024, r: 8, p: 1, salt: Buffer.alloc(16).toString("base64") },
        cipher: {
          name: "aes-256-gcm",
          iv: Buffer.alloc(4).toString("base64"),
          tag: Buffer.alloc(16).toString("base64"),
        },
        ct: "AAAA",
      }),
      FILE_MODE,
    );

    await expect(vault.get("c1")).rejects.toBeInstanceOf(CredentialDecryptError);
    expect(seen).toHaveLength(1);
  });

  test("delete removes the file and the cached passphrase", async () => {
    const { paths, vault } = await store([PASSPHRASE]);
    await vault.set("c1", "cfut_test_token_value");

    await vault.delete("c1");
    expect(await vault.get("c1")).toBeNull();
    await expect(readFile(vaultFile(paths, "c1"), "utf8")).rejects.toThrow();

    // The cache went with it: a re-created vault asks for a new passphrase.
    const again = await store(["a different passphrase"], paths);
    await again.vault.set("c1", "cfut_another_token_value");
    expect(again.seen[0]!.reason).toBe("create");
  });
});

describe("the mechanism description", () => {
  test("names the cipher and the work factor actually in use", async () => {
    const { vault } = await store([]);
    const described = vault.describe();
    expect(described).toContain("passphrase");
    expect(described).toContain("AES-256-GCM");
    expect(described).toContain("scrypt");
    expect(described).toContain("N=2^10");
  });

  test("is always available, because it needs nothing from the system", async () => {
    const { vault } = await store([]);
    expect(await vault.isAvailable()).toBe(true);
    expect(vault.mode).toBe("passphrase");
  });
});
