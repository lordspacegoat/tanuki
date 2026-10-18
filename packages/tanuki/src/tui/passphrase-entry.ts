/**
 * The passphrase field and the rule for a new one.
 *
 * Deliberately separate from `masked-field.ts` even though the two look alike:
 * a token and a passphrase disagree about whitespace. Cloudflare tokens never
 * contain any, so `normaliseToken` strips it — which is what makes a wrapped
 * paste work. A passphrase *may* contain spaces, and stripping them would seal
 * the vault under something the user did not type and cannot retype.
 *
 * What is shared is the part that matters most: only the *length* is ever
 * painted. `maskedDisplay` is reused so a passphrase cannot reach the screen or
 * the scrollback any more than a token can (decision S7).
 */
import { MASK_CHARACTER, actionForKey, maskedDisplay } from "./masked-field.ts";
import type { FieldAction, MaskedField } from "./masked-field.ts";
import type { TextKey } from "./keys.ts";

/** A passphrase, unlike a token, is typed twice — so it may be long. */
export const MAX_PASSPHRASE_LENGTH = 256;

/**
 * Eight characters. Stated on screen, enforced here, and the only rule: there
 * is no composition requirement, because a long phrase of ordinary words beats
 * a short string of substitutions and this is not the place to argue about it.
 */
export const MIN_PASSPHRASE_LENGTH = 8;

export type PassphraseField = MaskedField;
export const emptyPassphrase: PassphraseField = { value: "" };

/**
 * Control characters are dropped rather than lost silently. A pasted
 * passphrase commonly carries a trailing newline from the terminal, and
 * newlines and tabs are never part of one — while a space very much can be.
 */
export function normalisePassphrase(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, "");
}

export function reducePassphrase(field: PassphraseField, action: FieldAction): PassphraseField {
  switch (action.type) {
    case "insert": {
      const text = normalisePassphrase(action.text);
      const room = MAX_PASSPHRASE_LENGTH - field.value.length;
      if (text.length === 0 || room <= 0) return field;
      return { value: field.value + text.slice(0, room) };
    }
    case "backspace":
      return field.value.length === 0 ? field : { value: field.value.slice(0, -1) };
    case "clear":
      return emptyPassphrase;
    default:
      return field;
  }
}

export type PassphraseKey = TextKey;

export function passphraseActionForKey(key: PassphraseKey): FieldAction {
  return actionForKey(key);
}

export function maskedPassphrase(field: PassphraseField, width: number): string {
  return maskedDisplay(field, width);
}

export type NewPassphraseCheck = { ok: true } | { ok: false; message: string };

/**
 * Whether a typed pair is acceptable as a new passphrase.
 *
 * Both failures are the user's to fix, so they are returned as a sentence for
 * the screen rather than thrown; the confirmation is checked first because a
 * mismatch is the more likely mistake and the more useful thing to say.
 */
export function checkNewPassphrase(passphrase: string, confirmation: string): NewPassphraseCheck {
  if (passphrase.length === 0) return { ok: false, message: "Type a passphrase." };
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, message: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.` };
  }
  if (passphrase !== confirmation) return { ok: false, message: "The two passphrases do not match." };
  return { ok: true };
}

export { MASK_CHARACTER };
