/**
 * The masked token field (decision S9).
 *
 * OpenTUI's `Input` renders its own value, which for a secret is exactly wrong:
 * the token would be painted onto the screen and left in the scrollback. So the
 * field is hand-rolled, and this file is the part of it worth testing — the
 * keystroke rules, the clamping, and the guarantee that only the *length* of the
 * token is ever rendered.
 *
 * Deliberately absent: a reveal toggle. There is no reason for a purge tool to
 * paint an API token onto a shared screen, and "temporarily" showing a secret is
 * how secrets end up in scrollback.
 */
import { textOf } from "./keys.ts";
import type { TextKey } from "./keys.ts";

export const TOKEN_MAX_LENGTH = 64;
export const MASK_CHARACTER = "•";

export interface MaskedField {
  value: string;
}

export const emptyField: MaskedField = { value: "" };

export type FieldAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "submit" }
  | { type: "ignore" };

/** The subset of a terminal key event this field cares about. */
export type KeyLike = TextKey;

/**
 * Maps a key event to an edit. Anything unrecognised — including any
 * control-modified key — is ignored rather than inserted, so a stray chord can
 * never inject a control character into a token.
 */
export function actionForKey(key: KeyLike): FieldAction {
  const name = key.name ?? "";

  if (key.ctrl || key.meta) {
    return name === "u" ? { type: "clear" } : { type: "ignore" };
  }

  if (name === "return" || name === "enter" || name === "linefeed") return { type: "submit" };
  if (name === "backspace") return { type: "backspace" };

  // The character comes from the key's *sequence*: a capital letter is reported
  // as name "b" with shift set, so inserting the name would lower-case it and
  // hand Cloudflare a token the user did not paste. Whitespace is the reducer's
  // business — `normaliseToken` strips it, including a pasted newline.
  const text = textOf(key);
  if (text !== null) return { type: "insert", text };

  return { type: "ignore" };
}

export function reduce(field: MaskedField, action: FieldAction): MaskedField {
  switch (action.type) {
    case "insert": {
      const text = normaliseToken(action.text);
      const room = TOKEN_MAX_LENGTH - field.value.length;
      if (text.length === 0 || room <= 0) return field;
      return { value: field.value + text.slice(0, room) };
    }
    case "backspace":
      return field.value.length === 0 ? field : { value: field.value.slice(0, -1) };
    case "clear":
      return emptyField;
    default:
      return field;
  }
}

/**
 * A pasted token may carry a trailing newline or the line breaks a terminal
 * inserted while wrapping it. Tokens never contain whitespace, so removing all
 * of it is lossless — and it is the difference between a working paste and a
 * confusing rejection.
 */
export function normaliseToken(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/**
 * What gets painted. Only the length survives; the value never appears in the
 * output, which is the property the tests pin.
 */
export function maskedDisplay(field: MaskedField, width: number): string {
  const count = Math.min(field.value.length, Math.max(0, Math.floor(width)));
  return MASK_CHARACTER.repeat(count);
}

export function lengthLabel(field: MaskedField): string {
  return `${field.value.length} of ${TOKEN_MAX_LENGTH} characters`;
}

/**
 * Whether the token is worth sending. Only emptiness is judged here — the field
 * does not guess at a token's shape, because Cloudflare's format is not ours to
 * assume. The real verdict comes from `GET /user/tokens/verify` (decision S9).
 */
export function canSubmit(field: MaskedField): boolean {
  return field.value.length > 0;
}

export function isEmpty(field: MaskedField): boolean {
  return field.value.length === 0;
}
