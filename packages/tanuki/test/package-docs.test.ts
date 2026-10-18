/**
 * The package's npm page is painted from the tarball, not from this repository:
 * npm reads the README and the licence out of `packages/tanuki/` at publish time
 * and stores them in the registry. With neither present, the page for
 * `@kumokaizen/tanuki` showed npm's placeholder — the literal string
 * "ERROR: No README data found!" — while the repository README sat right there,
 * unread (decision NS5).
 *
 * So both files are committed beside the manifest, and this keeps them the
 * repository's copies rather than a second version of the truth. It is the same
 * arrangement as `src/version.ts` and `package.json`: one source, one copy, and
 * a test that fails on drift.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "..");
const REPO = resolve(PACKAGE, "..", "..");

/** npm always includes these whatever `files` says, so they cannot be dropped. */
const DOCUMENTS = ["README.md", "LICENSE"];

describe("the package's published documents", () => {
  for (const name of DOCUMENTS) {
    test(`${name} is the repository's copy, byte for byte`, () => {
      const published = readFileSync(join(PACKAGE, name), "utf8");
      const source = readFileSync(join(REPO, name), "utf8");

      expect(published).toBe(source);
      // A truncated or empty copy would still be "in step" with a truncated or
      // empty original, so the point of shipping them is checked too.
      expect(published.trim().length).toBeGreaterThan(0);
    });
  }

  test("only bin/ is named in `files`", () => {
    // The README and the licence ride along regardless, which is exactly why
    // `files` stays as narrow as it is: nothing else in this directory — the
    // sources, the tests, the screenshot generator — is meant to be published.
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      files?: string[];
    };

    expect(manifest.files).toEqual(["bin"]);
  });
});
