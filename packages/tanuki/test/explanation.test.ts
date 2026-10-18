import { describe, expect, test } from "bun:test";
import { explainCredentials, explanationLines, onboardingScreens } from "../src/secrets/explanation.ts";
import type { ExplanationInput } from "../src/secrets/explanation.ts";

const macKeychain: ExplanationInput = {
  mode: "keychain",
  keychainAvailable: true,
  keychainLabel: "the macOS Keychain",
  platform: "darwin",
};

const linuxKeychain: ExplanationInput = {
  ...macKeychain,
  keychainLabel: "libsecret (your desktop keyring)",
  platform: "linux",
};

const passphrase: ExplanationInput = {
  mode: "passphrase",
  keychainAvailable: false,
  keychainLabel: "the macOS Keychain",
  platform: "darwin",
};

describe("keychain explanation", () => {
  test("names the mechanism that was actually detected", () => {
    expect(explainCredentials(macKeychain).title).toContain("macOS Keychain");
    expect(explainCredentials(linuxKeychain).title).toContain("libsecret");
    // The live label is quoted, so the copy cannot describe a different store.
    expect(explainCredentials(linuxKeychain).mechanism).toContain("libsecret (your desktop keyring)");
  });

  test("does not double up the label's own article", () => {
    // The real labels begin with "the", so "the the macOS Keychain" would be
    // the giveaway that the sentence was assembled carelessly.
    const copy = explainCredentials(macKeychain);
    for (const line of [copy.title, copy.mechanism, ...copy.protects]) {
      expect(line).not.toContain("the the ");
    }
  });

  test("says the configuration files hold no token", () => {
    expect(explainCredentials(macKeychain).protects.join(" ")).toContain("contain no token");
  });

  test("states what it does not protect", () => {
    const limits = explainCredentials(macKeychain).doesNotProtect.join(" ");
    expect(limits).toContain("as you");
    expect(explainCredentials(macKeychain).doesNotProtect.length).toBeGreaterThan(0);
  });

  test("declares the macOS argv caveat on macOS", () => {
    expect(explainCredentials(macKeychain).limitation).toContain("process table");
  });

  test("does not claim a macOS-specific caveat on Linux", () => {
    expect(explainCredentials(linuxKeychain).limitation).toBeNull();
  });
});

describe("passphrase explanation", () => {
  test("names the real primitives rather than hand-waving", () => {
    const mechanism = explainCredentials(passphrase).mechanism;
    expect(mechanism).toContain("AES-256-GCM");
    expect(mechanism).toContain("scrypt");
    expect(mechanism).toContain("N=2^17");
  });

  test("states plainly that the passphrase is stored nowhere", () => {
    expect(explainCredentials(passphrase).mechanism).toContain("stored nowhere");
  });

  test("never implies a local file is safe", () => {
    const copy = explainCredentials(passphrase);
    // The requirement is explicit: the copy must say a file is not a vault.
    expect(copy.doesNotProtect.join(" ")).toContain("A local file is not a vault");
    expect(copy.doesNotProtect.join(" ")).toContain("as strong as the passphrase");
  });

  test("admits that a wrong passphrase cannot be distinguished up front", () => {
    expect(explainCredentials(passphrase).limitation).toContain("cannot be checked");
  });
});

describe("onboarding", () => {
  test("is two screens, per decision S6", () => {
    expect(onboardingScreens(macKeychain)).toHaveLength(2);
  });

  test("the first screen explains, and the second offers the choice", () => {
    const [first, second] = onboardingScreens(macKeychain);
    expect(first.title).toBe(explainCredentials(macKeychain).title);
    expect(first.lines.join(" ")).toContain("macOS Keychain");
    expect(second.title).toContain("change");
    expect(second.action).toContain("passphrase");
  });

  test("when no store is available it says so instead of offering a keychain", () => {
    const [, second] = onboardingScreens(passphrase);
    expect(second.title).toContain("No system credential store");
    expect(second.lines.join(" ")).toContain("passphrase-encrypted file");
  });

  test("every screen offers exactly one next action", () => {
    for (const screen of onboardingScreens(macKeychain)) {
      expect(screen.action).not.toBeNull();
    }
  });
});

describe("help text", () => {
  test("renders the full explanation, including the limits", () => {
    const lines = explanationLines(passphrase).join("\n");
    expect(lines).toContain("What this protects:");
    expect(lines).toContain("What it does not protect:");
    expect(lines).toContain("Worth knowing:");
  });

  test("omits the caveat section when there is no caveat", () => {
    expect(explanationLines(linuxKeychain).join("\n")).not.toContain("Worth knowing:");
  });

  test("is stable enough to be read twice", () => {
    expect(explanationLines(macKeychain)).toEqual(explanationLines(macKeychain));
  });
});
