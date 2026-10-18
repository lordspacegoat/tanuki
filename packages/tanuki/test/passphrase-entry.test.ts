/**
 * The passphrase field's rules: what counts as a passphrase, and what counts as
 * a new one.
 *
 * The two claims worth pinning are that a space survives (a passphrase is not a
 * token) and that no part of the value is ever painted (a passphrase is not a
 * name either).
 */
import { describe, expect, test } from "bun:test";
import {
  checkNewPassphrase,
  emptyPassphrase,
  maskedPassphrase,
  MAX_PASSPHRASE_LENGTH,
  MIN_PASSPHRASE_LENGTH,
  normalisePassphrase,
  passphraseActionForKey,
  reducePassphrase,
} from "../src/tui/passphrase-entry.ts";

const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });

describe("normalisePassphrase", () => {
  test("keeps spaces, which a token reducer would strip", () => {
    expect(normalisePassphrase("correct horse battery staple")).toBe("correct horse battery staple");
  });

  test("drops the control characters a paste drags in", () => {
    expect(normalisePassphrase("hunter2\n")).toBe("hunter2");
    expect(normalisePassphrase("a\tb")).toBe("ab");
    expect(normalisePassphrase("a\u0000b\u007fc")).toBe("abc");
    // Leading and trailing spaces are the user's, and are kept.
    expect(normalisePassphrase("  spaced  ")).toBe("  spaced  ");
  });
});

describe("reducePassphrase", () => {
  test("inserts, deletes and clears", () => {
    const typed = reducePassphrase(emptyPassphrase, { type: "insert", text: "hunter two" });
    expect(typed.value).toBe("hunter two");
    expect(reducePassphrase(typed, { type: "backspace" }).value).toBe("hunter tw");
    expect(reducePassphrase(typed, { type: "clear" }).value).toBe("");
  });

  test("stops at the maximum rather than growing without bound", () => {
    const full = reducePassphrase(emptyPassphrase, {
      type: "insert",
      text: "x".repeat(MAX_PASSPHRASE_LENGTH + 50),
    });
    expect(full.value).toHaveLength(MAX_PASSPHRASE_LENGTH);
    expect(reducePassphrase(full, { type: "insert", text: "more" }).value).toHaveLength(MAX_PASSPHRASE_LENGTH);
  });

  test("a submit or an ignored action changes nothing", () => {
    const typed = reducePassphrase(emptyPassphrase, { type: "insert", text: "abc" });
    expect(reducePassphrase(typed, { type: "submit" })).toBe(typed);
    expect(reducePassphrase(typed, { type: "ignore" })).toBe(typed);
    expect(reducePassphrase(typed, { type: "insert", text: "\n\t" })).toBe(typed);
  });
});

describe("passphraseActionForKey", () => {
  test("takes the character from the sequence, so a capital stays capital", () => {
    // A terminal reports a capital letter as name "b" with shift set. Reading
    // the name would lower-case it and store a passphrase nobody typed.
    expect(passphraseActionForKey(key("b", { sequence: "B", shift: true }))).toEqual({
      type: "insert",
      text: "B",
    });
    // Space arrives as a name, not a sequence.
    expect(passphraseActionForKey(key("space"))).toEqual({ type: "insert", text: " " });
  });

  test("never treats a control chord as text", () => {
    expect(passphraseActionForKey(key("c", { ctrl: true, sequence: "\u0003" }))).toEqual({ type: "ignore" });
    expect(passphraseActionForKey(key("u", { ctrl: true }))).toEqual({ type: "clear" });
    expect(passphraseActionForKey(key("v", { meta: true }))).toEqual({ type: "ignore" });
  });

  test("maps the editing keys", () => {
    expect(passphraseActionForKey(key("return"))).toEqual({ type: "submit" });
    expect(passphraseActionForKey(key("backspace"))).toEqual({ type: "backspace" });
  });
});

describe("maskedPassphrase", () => {
  const field = { value: "correct horse battery staple" };

  test("paints the length and nothing else", () => {
    const painted = maskedPassphrase(field, 40);
    expect(painted).toBe("•".repeat(field.value.length));
    expect(painted).not.toContain("correct");
    expect(painted).not.toContain("horse");
  });

  test("is clipped to the field, so it cannot push a row around", () => {
    expect(maskedPassphrase(field, 4)).toBe("••••");
    expect(maskedPassphrase(field, 0)).toBe("");
  });
});

describe("checkNewPassphrase", () => {
  test("refuses an empty or a short passphrase", () => {
    expect(checkNewPassphrase("", "")).toEqual({ ok: false, message: "Type a passphrase." });
    expect(checkNewPassphrase("short", "short")).toEqual({
      ok: false,
      message: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    });
  });

  test("refuses a mismatch, and says so before saying anything else", () => {
    expect(checkNewPassphrase("correct horse", "correct horsey")).toEqual({
      ok: false,
      message: "The two passphrases do not match.",
    });
  });

  test("accepts a passphrase that is long enough and typed twice", () => {
    expect(checkNewPassphrase("correct horse", "correct horse")).toEqual({ ok: true });
  });
});
