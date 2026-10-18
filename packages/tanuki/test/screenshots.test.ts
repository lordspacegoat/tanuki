/**
 * The README screenshots and the files behind them, kept in step.
 *
 * What the pictures *contain* is not checked here — that is
 * `scripts/screenshots.tsx`'s job, and re-rendering them on every test run would
 * be slow for no extra confidence. What this pins is the seam a reader actually
 * hits: a markdown link to a file that is not there is a broken image, and a
 * file nobody links to is a screenshot nobody sees. Both fail silently.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const ASSETS = join(REPO, "assets", "screenshots");
const README = readFileSync(join(REPO, "README.md"), "utf8");

describe("README screenshots", () => {
  const files = readdirSync(ASSETS).filter((name) => name.endsWith(".svg"));

  test("there are screenshots to show", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("every screenshot file is shown in the README", () => {
    const unshown = files.filter((name) => !README.includes(`assets/screenshots/${name}`));
    expect(unshown).toEqual([]);
  });

  test("every screenshot the README shows exists", () => {
    const shown = [...README.matchAll(/assets\/screenshots\/([^)"\s]+)/g)].map((match) => match[1]!);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((name) => !files.includes(name))).toEqual([]);
  });

  test("every screenshot is an SVG, and one that runs no script", () => {
    for (const name of files) {
      const svg = readFileSync(join(ASSETS, name), "utf8");
      expect(svg.startsWith("<svg")).toBe(true);
      // A README image is rendered in a browser; it has no business running code.
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("javascript:");
    }
  });
});
