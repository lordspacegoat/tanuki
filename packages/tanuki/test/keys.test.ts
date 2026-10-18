/**
 * The "does this key add text" rule, tested on its own because three screens and
 * the token field all depend on it. The two cases that bite in practice are a
 * capital letter (reported as a lower-case name plus shift, with the case only in
 * the sequence) and space (reported as the name "space").
 */
import { describe, expect, test } from "bun:test";
import { textOf } from "../src/tui/keys.ts";

describe("textOf", () => {
  test("a printable character contributes itself", () => {
    expect(textOf({ name: "a" })).toBe("a");
    expect(textOf({ name: "-" })).toBe("-");
    expect(textOf({ name: "7" })).toBe("7");
  });

  test("a capital letter keeps its case, because the sequence says so", () => {
    expect(textOf({ name: "b", sequence: "B" })).toBe("B");
    expect(textOf({ name: "b", sequence: "b" })).toBe("b");
    // A shifted symbol arrives the same way.
    expect(textOf({ name: "1", sequence: "!" })).toBe("!");
  });

  test("space contributes a space in either spelling", () => {
    expect(textOf({ name: "space", sequence: " " })).toBe(" ");
    expect(textOf({ name: "space" })).toBe(" ");
  });

  test("control characters contribute nothing, however short they are", () => {
    expect(textOf({ name: "return", sequence: "\r" })).toBeNull();
    expect(textOf({ name: "tab", sequence: "\t" })).toBeNull();
    expect(textOf({ name: "linefeed", sequence: "\n" })).toBeNull();
    expect(textOf({ name: "backspace", sequence: "\x7f" })).toBeNull();
  });

  test("named keys contribute nothing", () => {
    expect(textOf({ name: "up" })).toBeNull();
    expect(textOf({ name: "escape" })).toBeNull();
    expect(textOf({ name: "f1" })).toBeNull();
  });

  test("a chord is a command, not text", () => {
    expect(textOf({ name: "a", ctrl: true })).toBeNull();
    expect(textOf({ name: "a", meta: true })).toBeNull();
    expect(textOf({ name: "space", sequence: " ", ctrl: true })).toBeNull();
  });

  test("a multi-character sequence is not text", () => {
    expect(textOf({ name: "up", sequence: "\x1B[A" })).toBeNull();
  });
});
