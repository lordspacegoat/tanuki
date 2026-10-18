import { describe, expect, test } from "bun:test";
import {
  MASK_CHARACTER,
  TOKEN_MAX_LENGTH,
  actionForKey,
  canSubmit,
  emptyField,
  isEmpty,
  lengthLabel,
  maskedDisplay,
  normaliseToken,
  reduce,
} from "../src/tui/masked-field.ts";
import type { MaskedField } from "../src/tui/masked-field.ts";

const TOKEN = "cfut_AbCdEf0123456789_-xyz";

function typed(text: string, field: MaskedField = emptyField): MaskedField {
  return reduce(field, { type: "insert", text });
}

describe("actionForKey", () => {
  test("a printable key inserts itself", () => {
    expect(actionForKey({ name: "a" })).toEqual({ type: "insert", text: "a" });
    expect(actionForKey({ name: "-" })).toEqual({ type: "insert", text: "-" });
  });

  test("a capital letter is inserted as itself, not lower-cased", () => {
    // The terminal reports a capital as name "b" with shift set, and only the
    // sequence carries the case. Reading the name would hand Cloudflare a
    // different token than the one typed.
    expect(actionForKey({ name: "b", sequence: "B" })).toEqual({ type: "insert", text: "B" });
    expect(actionForKey({ name: "b", sequence: "b" })).toEqual({ type: "insert", text: "b" });
  });

  test("backspace deletes", () => {
    expect(actionForKey({ name: "backspace" })).toEqual({ type: "backspace" });
  });

  test("return submits", () => {
    expect(actionForKey({ name: "return" })).toEqual({ type: "submit" });
    expect(actionForKey({ name: "linefeed" })).toEqual({ type: "submit" });
  });

  test("ctrl+u clears, and every other chord is ignored", () => {
    expect(actionForKey({ name: "u", ctrl: true })).toEqual({ type: "clear" });
    // Ctrl+V must not be treated as a literal "v" — paste arrives as a paste event.
    expect(actionForKey({ name: "v", ctrl: true })).toEqual({ type: "ignore" });
    expect(actionForKey({ name: "c", ctrl: true })).toEqual({ type: "ignore" });
    expect(actionForKey({ name: "d", meta: true })).toEqual({ type: "ignore" });
    expect(actionForKey({ name: "a", ctrl: true })).toEqual({ type: "ignore" });
  });

  test("named keys are not mistaken for characters", () => {
    expect(actionForKey({ name: "up" })).toEqual({ type: "ignore" });
    expect(actionForKey({ name: "tab", sequence: "\t" })).toEqual({ type: "ignore" });
    expect(actionForKey({ name: "escape" })).toEqual({ type: "ignore" });
    expect(actionForKey({ name: "return", sequence: "\r" })).toEqual({ type: "submit" });
  });

  test("space is accepted and then stripped, so a token never keeps whitespace", () => {
    // The field no longer second-guesses the key: whitespace is removed by
    // `normaliseToken`, which is also the path a pasted newline takes.
    expect(actionForKey({ name: "space", sequence: " " })).toEqual({ type: "insert", text: " " });
    expect(reduce(typed("a"), actionForKey({ name: "space", sequence: " " })).value).toBe("a");
  });
});

describe("reduce", () => {
  test("accumulates keystrokes in order", () => {
    let field = emptyField;
    for (const character of "abc") field = typed(character, field);
    expect(field.value).toBe("abc");
  });

  test("backspace removes one character and stops at empty", () => {
    expect(reduce(typed("ab"), { type: "backspace" }).value).toBe("a");
    expect(reduce(emptyField, { type: "backspace" }).value).toBe("");
  });

  test("clear empties the field", () => {
    expect(reduce(typed(TOKEN), { type: "clear" }).value).toBe("");
  });

  test("submit changes nothing", () => {
    const field = typed(TOKEN);
    expect(reduce(field, { type: "submit" })).toEqual(field);
  });

  test("a paste is accepted whole, whitespace and all removed", () => {
    // A wrapped paste from a browser is the common case, not the exception.
    const pasted = "  cfut_AbCd\n  Ef0123 \t456789_-xyz\n";
    expect(reduce(emptyField, { type: "insert", text: pasted }).value).toBe(TOKEN);
  });

  test("clamps at the maximum length rather than truncating the field", () => {
    const field = reduce(emptyField, { type: "insert", text: "a".repeat(TOKEN_MAX_LENGTH) });
    expect(field.value).toHaveLength(TOKEN_MAX_LENGTH);

    // Anything further is rejected outright, not silently swallowed mid-token.
    expect(reduce(field, { type: "insert", text: "b" })).toEqual(field);
    expect(reduce(field, { type: "insert", text: "b".repeat(50) })).toEqual(field);
  });

  test("clamps a paste that overshoots into the remaining space", () => {
    const field = typed("a".repeat(TOKEN_MAX_LENGTH - 2));
    const next = reduce(field, { type: "insert", text: "xyz" });
    expect(next.value).toHaveLength(TOKEN_MAX_LENGTH);
    expect(next.value.endsWith("xy")).toBe(true);
  });

  test("whitespace-only input is a no-op rather than a space in the token", () => {
    expect(reduce(emptyField, { type: "insert", text: "   \n" })).toEqual(emptyField);
    expect(reduce(typed("a"), { type: "insert", text: " " }).value).toBe("a");
  });

  test("editing never mutates the previous state", () => {
    const before = typed("ab");
    const snapshot = before.value;
    reduce(before, { type: "backspace" });
    expect(before.value).toBe(snapshot);
  });
});

describe("what is rendered", () => {
  test("only the length is painted — the token never reaches the screen", () => {
    const field = typed(TOKEN);
    const painted = maskedDisplay(field, 200);

    expect(painted).toBe(MASK_CHARACTER.repeat(TOKEN.length));
    // The load-bearing assertion: no character of the secret appears anywhere.
    for (const character of new Set([...TOKEN])) {
      if (character === MASK_CHARACTER) continue;
      expect(painted).not.toContain(character);
    }
  });

  test("the mask is clipped to the available width, never overflowing", () => {
    const field = typed(TOKEN);
    expect(maskedDisplay(field, 5)).toHaveLength(5);
    expect(maskedDisplay(field, 0)).toBe("");
    expect(maskedDisplay(field, -3)).toBe("");
  });

  test("an empty field paints nothing", () => {
    expect(maskedDisplay(emptyField, 40)).toBe("");
  });

  test("the counter reports length, not content", () => {
    expect(lengthLabel(typed(TOKEN))).toBe(`${TOKEN.length} of ${TOKEN_MAX_LENGTH} characters`);
    expect(lengthLabel(emptyField)).toBe(`0 of ${TOKEN_MAX_LENGTH} characters`);
  });
});

describe("submission", () => {
  test("a populated field can be submitted", () => {
    expect(canSubmit(typed(TOKEN))).toBe(true);
  });

  test("an empty field cannot", () => {
    expect(canSubmit(emptyField)).toBe(false);
    expect(isEmpty(emptyField)).toBe(true);
    expect(isEmpty(typed("x"))).toBe(false);
  });

  test("the field does not pretend to know the token format", () => {
    // Short, unusual values are allowed through to Cloudflare's verdict rather
    // than rejected by a local guess about a format that is not ours.
    expect(canSubmit(typed("x"))).toBe(true);
    expect(canSubmit(typed("not-a-real-token"))).toBe(true);
  });
});

describe("normaliseToken", () => {
  test("is the same rule the field applies", () => {
    expect(normaliseToken(" a\tb\nc ")).toBe("abc");
    expect(normaliseToken(TOKEN)).toBe(TOKEN);
  });
});
