import { describe, expect, test } from "bun:test";
import { main } from "../src/index.ts";
import { VERSION } from "../src/version.ts";

function harness(isTTY: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      isTTY,
    },
  };
}

describe("main", () => {
  test("--help prints usage and exits 0 without touching the renderer", async () => {
    const h = harness(true);
    expect(await main(["--help"], h.io)).toBe(0);
    expect(h.out.join("")).toContain("USAGE");
    expect(h.out.join("")).toContain("--config");
    expect(h.err).toEqual([]);
  });

  test("--version prints the version and exits 0", async () => {
    const h = harness(true);
    expect(await main(["--version"], h.io)).toBe(0);
    expect(h.out.join("")).toBe(`tanuki ${VERSION}\n`);
  });

  test("a bad flag exits 2 with a hint", async () => {
    const h = harness(true);
    expect(await main(["--nope"], h.io)).toBe(2);
    expect(h.err.join("")).toContain("unknown option");
    expect(h.err.join("")).toContain("--help");
  });

  test("a non-TTY refuses to launch and never emits escape codes", async () => {
    const h = harness(false);
    expect(await main([], h.io)).toBe(1);
    const output = h.out.join("");
    expect(output).toContain("not a terminal");
    expect(output).not.toContain("\u001b[");
  });
});

describe("version", () => {
  test("matches package.json, so a published binary cannot disagree with its package", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
