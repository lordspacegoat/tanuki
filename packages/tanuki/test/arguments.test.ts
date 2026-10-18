import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/cli/arguments.ts";

describe("parseArguments", () => {
  test("no arguments opens the selector", () => {
    expect(parseArguments([])).toEqual({ kind: "run", config: null });
  });

  test("long and short config flags", () => {
    expect(parseArguments(["--config", "client"])).toEqual({ kind: "run", config: "client" });
    expect(parseArguments(["-c", "client"])).toEqual({ kind: "run", config: "client" });
    expect(parseArguments(["--config=client"])).toEqual({ kind: "run", config: "client" });
  });

  test("config names are trimmed", () => {
    expect(parseArguments(["-c", "  client  "])).toEqual({ kind: "run", config: "client" });
  });

  test("help and version short-circuit before anything else", () => {
    expect(parseArguments(["--help", "--config", "client"])).toEqual({ kind: "help" });
    expect(parseArguments(["-h"])).toEqual({ kind: "help" });
    expect(parseArguments(["--version"])).toEqual({ kind: "version" });
    expect(parseArguments(["-V"])).toEqual({ kind: "version" });
  });

  test("a missing config value is an error, not a silent fallback", () => {
    const result = parseArguments(["--config"]);
    expect(result.kind).toBe("error");
  });

  test("an empty config value is an error", () => {
    const result = parseArguments(["--config", "   "]);
    expect(result.kind).toBe("error");
  });

  test("unknown options are rejected", () => {
    const result = parseArguments(["--frobnicate"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("--frobnicate");
  });

  test("positional arguments are rejected", () => {
    const result = parseArguments(["purge"]);
    expect(result.kind).toBe("error");
  });

  test("a bare -- is accepted and terminates parsing", () => {
    expect(parseArguments(["--"])).toEqual({ kind: "run", config: null });
  });
});
