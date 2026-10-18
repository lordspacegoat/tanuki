/**
 * The credential-storage explanation (decision S6).
 *
 * Two rules shape this file:
 *
 *  - The copy is generated from the mechanism that was actually detected, not
 *    written twice. `keychainLabel` comes from the live backend, so the sentence
 *    a user reads cannot drift from what the program is doing.
 *  - It never implies a local file is safe. Where the protection is a
 *    passphrase, it says so plainly — a file whose key sits beside it is not a
 *    vault, and the text must not pretend otherwise.
 *
 * Both the first-run onboarding and the in-app help read from here, so there is
 * exactly one description of how credentials are protected, and it stays
 * re-readable rather than shown once and lost.
 */
import type { CredentialMode } from "./types.ts";

export interface ExplanationInput {
  mode: CredentialMode;
  /** Whether the operating system store is genuinely usable right now. */
  keychainAvailable: boolean;
  /** The live backend's own name for itself, e.g. "macOS Keychain". */
  keychainLabel: string;
  platform: NodeJS.Platform;
}

export interface MechanismExplanation {
  mode: CredentialMode;
  title: string;
  /** What happens on this machine, in the mechanism's own terms. */
  mechanism: string;
  protects: string[];
  doesNotProtect: string[];
  /** A documented caveat, or null. Never omitted when one exists. */
  limitation: string | null;
}

/**
 * The macOS `security` command takes the secret as an argument, so it is
 * briefly visible in the process table to anything running as the same user.
 * This is a real, accepted limitation and it is stated, not buried.
 */
const MACOS_ARGV_LIMITATION =
  "On macOS, the moment the token is saved it is briefly visible in the process table (to " +
  "`ps`, as your own user only). It is never written to disk by Tanuki.";

export function explainCredentials(input: ExplanationInput): MechanismExplanation {
  if (input.mode === "keychain") {
    return {
      mode: "keychain",
      title: `Your token is in ${input.keychainLabel}`,
      mechanism:
        `Tanuki handed your token to ${input.keychainLabel} through the operating system's ` +
        `own tool. It is not written into any file Tanuki creates, and Tanuki never prints it.`,
      protects: [
        "Tanuki's configuration files and its index contain no token at all.",
        `Only your logged-in account can read the item back out of ${input.keychainLabel}.`,
        "Backing up or syncing Tanuki's directory copies no secret with it.",
      ],
      doesNotProtect: [
        "Another program running as you can ask the same store for the same item.",
        "Anything that can run code as your user account can read the token.",
      ],
      limitation: input.platform === "darwin" ? MACOS_ARGV_LIMITATION : null,
    };
  }

  return {
    mode: "passphrase",
    title: "Your token is in an encrypted file",
    mechanism:
      "The token is sealed with AES-256-GCM using a key derived from your passphrase with scrypt " +
      "(N=2^17, r=8, p=1) and a unique 16-byte salt. The passphrase is stored nowhere — not in the " +
      "file, not in the keychain, not in a hint. Tanuki cannot recover it for you.",
    protects: [
      "The file is useless without your passphrase, so a copied or synced file reveals nothing.",
      "Nothing else on the machine holds the key, because no key is stored at all.",
    ],
    doesNotProtect: [
      "A local file is not a vault: anyone who can read the file and learn the passphrase can read the token.",
      "The protection is exactly as strong as the passphrase you chose.",
      "While Tanuki is running with a configuration unlocked, the token is in memory.",
    ],
    limitation:
      "A forgotten passphrase cannot be recovered and cannot be checked — Tanuki only finds out a " +
      "passphrase is wrong when a decryption fails.",
  };
}

export interface OnboardingScreen {
  title: string;
  lines: string[];
  /**
   * The single keystroke offered on this screen, or null when it just advances.
   * Decision S4: the keychain is preferred, with a one-keystroke opt-out.
   */
  action: string | null;
}

/**
 * Decision S6: two screens, not a wall of text. The first says how the token is
 * protected; the second says what that means for the choice the user is about
 * to make, and offers the alternative in one keystroke.
 */
export function onboardingScreens(input: ExplanationInput): [OnboardingScreen, OnboardingScreen] {
  const explanation = explainCredentials(input);

  const alternative: OnboardingScreen = input.keychainAvailable
    ? {
        title: "What you can change",
        lines: [
          `Tanuki will use ${input.keychainLabel}, because it is available on this machine.`,
          "If you would rather not touch the system store, press p to use a passphrase-encrypted",
          "file instead. You choose the passphrase, and it is stored nowhere.",
          "",
          "Either way the token is never written to a Tanuki configuration file.",
        ],
        action: "p  use a passphrase instead",
      }
    : {
        title: "No system credential store was found",
        lines: [
          "Tanuki could not reach a usable system credential store on this machine, so it will use",
          "a passphrase-encrypted file. You choose the passphrase, and it is stored nowhere.",
          "",
          "You can move a configuration to the system store later by re-entering the token.",
        ],
        action: "p  continue with a passphrase",
      };

  return [
    {
      title: explanation.title,
      lines: [explanation.mechanism, "", ...explanation.protects],
      action: "enter  continue",
    },
    alternative,
  ];
}

/** The full explanation as flat lines, for the in-app help overlay. */
export function explanationLines(input: ExplanationInput): string[] {
  const explanation = explainCredentials(input);
  const lines = [
    explanation.title,
    "",
    explanation.mechanism,
    "",
    "What this protects:",
    ...explanation.protects.map((line) => `  • ${line}`),
    "",
    "What it does not protect:",
    ...explanation.doesNotProtect.map((line) => `  • ${line}`),
  ];

  if (explanation.limitation) {
    lines.push("", "Worth knowing:", `  • ${explanation.limitation}`);
  }

  return lines;
}
