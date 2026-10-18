/**
 * The seam between this repository and a user's machine: the shim npm installs,
 * and the platform packages the release workflow publishes (decision F6).
 *
 * The target list is read from `scripts/build-platform.ts` through its command
 * line, the way the workflow reads it, rather than imported — that keeps a file
 * outside the package out of the typecheck, and it keeps these tests on the
 * interface that actually ships. What each target *means* is stated here, so the
 * manifests are checked against an independent expectation rather than against
 * the table they were written from.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version.ts";

const PACKAGE = resolve(import.meta.dir, "..");
const PLATFORMS = resolve(PACKAGE, "..");
const REPO = resolve(PLATFORMS, "..");
const SCRIPT = join(REPO, "scripts", "build-platform.ts");
const SHIM = join(PACKAGE, "bin", "tanuki.js");

/** What each target is for. Adding one to the build script fails these tests. */
const EXPECTED: Record<string, { os: string; cpu: string; libc?: string }> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64" },
  "linux-x64-musl": { os: "linux", cpu: "x64", libc: "musl" },
  "linux-arm64": { os: "linux", cpu: "arm64" },
  "linux-arm64-musl": { os: "linux", cpu: "arm64", libc: "musl" },
  "win32-x64": { os: "win32", cpu: "x64" },
};

interface PlatformManifest {
  name: string;
  version: string;
  os: string[];
  cpu: string[];
  libc?: string[];
  files: string[];
  publishConfig?: Record<string, unknown>;
}

interface BuildMatrix {
  include: { target: string; runner: string }[];
}

function buildScript(...args: string[]) {
  const result = spawnSync("bun", ["run", SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`build-platform ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function platformManifest(target: string): Promise<PlatformManifest> {
  const file = join(PLATFORMS, `tanuki-${target}`, "package.json");
  return JSON.parse(await readFile(file, "utf8")) as PlatformManifest;
}

async function shimManifest(): Promise<{
  optionalDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
}> {
  return JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
}

/** The package names the shim can be asked for at all. */
function shimPackages(): string[] {
  const source = readFileSync(SHIM, "utf8");
  return [...source.matchAll(/"(@kumokaizen\/tanuki-[a-z0-9-]+)"/g)].map((match) => match[1] as string);
}

/** The package name the shim asks for on this machine, by the same rule it uses. */
function hostPackage() {
  const suffix = process.platform === "linux" && existsSync("/etc/alpine-release") ? "-musl" : "";
  return `@kumokaizen/tanuki-${process.platform}-${process.arch}${suffix}`;
}

/**
 * Extra flags for running the shim, per runtime.
 *
 * Given a name it cannot resolve, Bun installs it from the registry on the spot
 * and then resolves it — so the "the platform package is missing" case stops
 * being reproducible the moment this package is actually published, and the test
 * downloads the published binary to prove it. It did exactly that. `--no-install`
 * keeps resolution local, which the no-network rule in the README requires. Node
 * has no such behaviour and takes no flag.
 */
const RUNTIME_FLAGS = process.versions.bun ? ["--no-install"] : [];

/** A throwaway install with the shim in it, and a stand-in platform package. */
async function fakeInstall(body: string | null) {
  const home = await mkdtemp(join(tmpdir(), "tanuki-install-"));
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(join(home, "bin", "tanuki.js"), await readFile(SHIM));

  if (body !== null) {
    const packageDir = join(home, "node_modules", ...hostPackage().split("/"));
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), `${JSON.stringify({ name: hostPackage(), version: VERSION })}\n`);
    const binary = join(packageDir, "bin", process.platform === "win32" ? "tanuki.exe" : "tanuki");
    await writeFile(binary, body);
    await chmod(binary, 0o755);
  }

  return {
    run: (...args: string[]) =>
      spawnSync(process.execPath, [...RUNTIME_FLAGS, join(home, "bin", "tanuki.js"), ...args], {
        encoding: "utf8",
      }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

describe("platform packages", () => {
  test("every target has a committed package, and the shim can reach all of them", async () => {
    const { include } = JSON.parse(buildScript("--matrix")) as BuildMatrix;
    const targets = include.map((entry) => entry.target);

    // A target the build script knows about but this test does not is a new
    // platform whose manifest nothing here has checked.
    expect(targets.toSorted()).toEqual(Object.keys(EXPECTED).toSorted());

    const names = targets.map((target) => `@kumokaizen/tanuki-${target}`);
    const shim = await shimManifest();

    // Equal sets, not just one direction: a package nobody asks for is as
    // broken as one that was never published. Set equality also pins the shim's
    // own target table, which is what actually picks the package at run time.
    expect(Object.keys(shim.optionalDependencies ?? {}).toSorted()).toEqual(names.toSorted());
    expect(shimPackages().toSorted()).toEqual(names.toSorted());

    // Every one of them at the version being released, or npm installs none of
    // them and every user gets "the binary package was not installed".
    for (const range of Object.values(shim.optionalDependencies ?? {})) {
      expect(range).toBe(VERSION);
    }
  });

  test("each platform package declares the machines it serves", async () => {
    for (const [target, expected] of Object.entries(EXPECTED)) {
      const manifest = await platformManifest(target);

      expect(manifest.name).toBe(`@kumokaizen/tanuki-${target}`);
      expect(manifest.os).toEqual([expected.os]);
      expect(manifest.cpu).toEqual([expected.cpu]);
      expect(manifest.files).toEqual(["bin"]);
      expect(manifest.publishConfig).toEqual({ access: "public" });

      // Only musl declares a libc. A package that declares none matches any
      // libc, so a glibc machine still resolves exactly one package and a
      // machine npm cannot classify still resolves something.
      expect(manifest.libc).toEqual(expected.libc ? [expected.libc] : undefined);
    }

    // Checked together, and last: a version bump has to reach every manifest, and
    // stopping at the first stale one would make the sixth look like the first.
    const versions: Record<string, string> = {};
    for (const target of Object.keys(EXPECTED)) {
      versions[`tanuki-${target}`] = (await platformManifest(target)).version;
    }
    expect(versions).toEqual(
      Object.fromEntries(Object.keys(EXPECTED).map((target) => [`tanuki-${target}`, VERSION])),
    );
  });

  test("macOS is built on macOS", async () => {
    const { include } = JSON.parse(buildScript("--matrix")) as BuildMatrix;

    for (const { target, runner } of include) {
      // darwin binaries are not built from Linux: they carry the linker-signed
      // ad-hoc signature that macOS arm64 refuses to execute without.
      const expected = target.startsWith("darwin") ? "macos" : "ubuntu";
      expect(`${target}: ${runner}`).toStartWith(`${target}: ${expected}`);
    }
  });

  test("the shim has no runtime dependencies, and publishes publicly", async () => {
    const shim = await shimManifest();

    // The application is a compiled binary: anything listed here would be
    // downloaded by every user and never imported.
    expect(Object.keys(shim.dependencies ?? {})).toEqual([]);

    // A scoped package is restricted unless it says otherwise, and a restricted
    // publish either fails or goes private — which for this package means nobody
    // can install it at all.
    expect(shim.publishConfig).toEqual({ access: "public" });
  });

  // A Windows platform package is a PE executable, which cannot be stood in for
  // by a script — that path needs a Windows runner, not a bigger test.
  const onWindows = process.platform === "win32";
  const supported = shimPackages().includes(hostPackage());

  test.skipIf(onWindows || !supported)("the shim hands over to this machine's platform package", async () => {
    const install = await fakeInstall('#!/bin/sh\necho "stand-in $@"\n');
    try {
      const result = install.run("--config", "client");

      expect(result.stdout).toBe("stand-in --config client\n");
      expect(result.status).toBe(0);
    } finally {
      await install.cleanup();
    }
  });

  test.skipIf(onWindows || !supported)("the application's exit status comes back through the shim", async () => {
    const install = await fakeInstall("#!/bin/sh\nexit 3\n");
    try {
      expect(install.run("--version").status).toBe(3);
    } finally {
      await install.cleanup();
    }
  });

  test.skipIf(onWindows || !supported)("a missing platform package says so instead of doing nothing", async () => {
    const install = await fakeInstall(null);
    try {
      const result = install.run("--version");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("was not installed");
      expect(result.stderr).toContain(hostPackage());
    } finally {
      await install.cleanup();
    }
  });
});
