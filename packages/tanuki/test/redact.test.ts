import { describe, expect, test } from "bun:test";
import { fingerprint, redact, redactValue } from "../src/services/redact.ts";

const TOKEN = "cfut_0123456789abcdefghijklmnopqrstuvwxyzABCD";

describe("redact", () => {
  test("removes Cloudflare token shapes", () => {
    expect(redact(`token is ${TOKEN}`)).toBe("token is [redacted]");
  });

  test("removes account tokens and API keys too", () => {
    expect(redact("cfat_abcdefghijklmnop")).toBe("[redacted]");
    expect(redact("cfk_abcdefghijklmnop")).toBe("[redacted]");
  });

  test("removes bearer values, keeping the scheme", () => {
    const output = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output).toContain("[redacted]");
  });

  test("removes header values from JSON snippets", () => {
    const json = '{"authorization":"Bearer abcdefghijklmnopqrstuvwxyz"}';
    expect(redact(json)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  test("leaves ordinary text alone", () => {
    expect(redact("purged example.com in 120ms")).toBe("purged example.com in 120ms");
  });

  test("is idempotent", () => {
    const once = redact(`bearer ${TOKEN}`);
    expect(redact(once)).toBe(once);
  });
});

describe("redactValue", () => {
  test("walks objects and arrays", () => {
    const value = { a: [TOKEN], b: { c: TOKEN } };
    expect(JSON.stringify(redactValue(value))).not.toContain(TOKEN);
  });

  test("redacts message and stack on errors", () => {
    const error = new Error(`failed for ${TOKEN}`);
    const result = redactValue(error) as { message: string; stack?: string };
    expect(result.message).not.toContain(TOKEN);
    expect(result.stack ?? "").not.toContain(TOKEN);
  });

  test("survives cycles", () => {
    const cycle: Record<string, unknown> = { name: "x" };
    cycle["self"] = cycle;
    expect(() => redactValue(cycle)).not.toThrow();
  });

  test("bounds depth", () => {
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(() => redactValue(deep)).not.toThrow();
  });
});

describe("fingerprint", () => {
  test("shows only a prefix and suffix", () => {
    const shown = fingerprint(TOKEN);
    expect(shown.length).toBeLessThanOrEqual(9);
    expect(shown).toContain("…");
    expect(shown.startsWith(TOKEN.slice(0, 4))).toBe(true);
    expect(shown.endsWith(TOKEN.slice(-4))).toBe(true);
  });

  test("gives nothing away for a very short value", () => {
    expect(fingerprint("abc")).toBe("…");
  });
});
