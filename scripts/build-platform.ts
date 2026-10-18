#!/usr/bin/env bun
/**
 * Builds the binary for one platform package.
 *
 * `@spacegoat/tanuki` is a Node shim; the application is a `bun build --compile`
 * binary, and npm can only fetch one file per platform, so each platform has a
 * package of its own under `packages/tanuki-<os>-<arch>` — declaring `os`, `cpu`
 * and `libc` so npm installs exactly the right one — and the shim hands over to
 * whichever one it finds (decision F6). Those manifests are committed; this
 * script writes the `bin/` they serve, and `.github/workflows/release.yml`
 * publishes them from a version tag.
 *
 * ## Why cross-compiling works
 *
 * Bun's `--compile` needs no toolchain for the target: it concatenates a
 * prebuilt runtime blob with the bundle. The one genuinely target-specific
 * input is OpenTUI's native library, which OpenTUI resolves with a *static*
 * dynamic import per platform:
 *
 *     if (process.platform === "linux" && process.arch === "x64") {
 *       return (await import("@opentui/core-linux-x64")).default;
 *     }
 *
 * Bun constant-folds `process.platform` and `process.arch` for the requested
 * target, so exactly one branch survives, and because that surviving import is
 * a *literal* specifier, **the build fails outright if the package cannot be
 * resolved**. That is the guarantee this script leans on: a successful build
 * means the target's native library was found and embedded.
 *
 * `verify` then proves it, by finding the library's own bytes inside the
 * finished executable. That check is worth having because most targets cannot
 * be executed on the machine that built them — and it is a strong one, because
 * Bun embeds a `type: "file"` asset verbatim.
 *
 * The `OPENTUI_LIBC` branch in OpenTUI is *not* foldable (it reads an
 * environment variable), so a Linux target always embeds both the glibc and the
 * musl library and the choice between them is made at run time.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages", "tanuki", "src", "index.ts");
const MANIFEST = join(ROOT, "packages", "tanuki", "package.json");

type Format = "elf" | "macho" | "pe";

export interface Target {
  /** Platform suffix. Half of the shim's key and of the package name. */
  id: string;
  /** `bun build --compile --target=`. */
  bun: string;
  /**
   * The OpenTUI native packages that must be resolvable for this target. Linux
   * names two because the libc choice is made at run time (see the header).
   */
  natives: readonly string[];
  /** The library inside each of those packages. */
  nativeFile: string;
  /** The executable inside the package this script writes. */
  binary: string;
  format: Format;
  os: "darwin" | "linux" | "win32";
  cpu: "arm64" | "x64";
  /**
   * The GitHub runner the release workflow builds this on. macOS only for the
   * macOS targets: Bun's darwin executables carry a linker-signed ad-hoc
   * signature that macOS arm64 will not run without, so they are not built from
   * Linux even though they could be.
   */
  runner: "macos-14" | "ubuntu-24.04";
}

export const TARGETS: readonly Target[] = [
  {
    id: "darwin-arm64",
    bun: "bun-darwin-arm64",
    natives: ["@opentui/core-darwin-arm64"],
    nativeFile: "libopentui.dylib",
    binary: "tanuki",
    format: "macho",
    os: "darwin",
    cpu: "arm64",
    runner: "macos-14",
  },
  {
    id: "darwin-x64",
    bun: "bun-darwin-x64",
    natives: ["@opentui/core-darwin-x64"],
    nativeFile: "libopentui.dylib",
    binary: "tanuki",
    format: "macho",
    os: "darwin",
    cpu: "x64",
    runner: "macos-14",
  },
  {
    id: "linux-x64",
    bun: "bun-linux-x64",
    natives: ["@opentui/core-linux-x64", "@opentui/core-linux-x64-musl"],
    nativeFile: "libopentui.so",
    binary: "tanuki",
    format: "elf",
    os: "linux",
    cpu: "x64",
    runner: "ubuntu-24.04",
  },
  {
    id: "linux-x64-musl",
    bun: "bun-linux-x64-musl",
    natives: ["@opentui/core-linux-x64", "@opentui/core-linux-x64-musl"],
    nativeFile: "libopentui.so",
    binary: "tanuki",
    format: "elf",
    os: "linux",
    cpu: "x64",
    runner: "ubuntu-24.04",
  },
  {
    id: "linux-arm64",
    bun: "bun-linux-arm64",
    natives: ["@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl"],
    nativeFile: "libopentui.so",
    binary: "tanuki",
    format: "elf",
    os: "linux",
    cpu: "arm64",
    runner: "ubuntu-24.04",
  },
  {
    id: "linux-arm64-musl",
    bun: "bun-linux-arm64-musl",
    natives: ["@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl"],
    nativeFile: "libopentui.so",
    binary: "tanuki",
    format: "elf",
    os: "linux",
    cpu: "arm64",
    runner: "ubuntu-24.04",
  },
  {
    id: "win32-x64",
    bun: "bun-windows-x64",
    natives: ["@opentui/core-win32-x64"],
    nativeFile: "opentui.dll",
    binary: "tanuki.exe",
    format: "pe",
    os: "win32",
    cpu: "x64",
    runner: "ubuntu-24.04",
  },
];

const MAGIC: Record<Format, readonly number[]> = {
  elf: [0x7f, 0x45, 0x4c, 0x46],
  macho: [0xcf, 0xfa, 0xed, 0xfe],
  pe: [0x4d, 0x5a],
};

function fail(message: string): never {
  process.stderr.write(`build-platform: ${message}\n`);
  process.exit(1);
}

/** The manifest of `@spacegoat/tanuki` itself, plus what is derived from it. */
interface SourceManifest {
  [key: string]: unknown;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readManifest(): Promise<{
  manifest: SourceManifest;
  scope: string;
  base: string;
  openTuiVersion: string;
}> {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as SourceManifest;
  const [scope, base] = manifest.name.split("/");
  if (!scope?.startsWith("@") || !base) {
    fail(`${MANIFEST} has a name this script cannot turn into platform packages.`);
  }

  // The application ships as a compiled binary, so nothing is imported from
  // `node_modules` at run time — `bin/tanuki.js` reaches for Node built-ins and
  // then for the platform package. Anything in `dependencies` would therefore be
  // downloaded by every user for nothing, so it is an error rather than a silent
  // waste. The build's own imports belong in `devDependencies`.
  const runtime = Object.keys(manifest.dependencies ?? {});
  if (runtime.length > 0) {
    fail(
      `${MANIFEST} lists runtime dependencies (${runtime.join(", ")}), but the shim has none.\n` +
        `  Move them to devDependencies: they are only needed to build and test.`,
    );
  }

  // The native packages are versioned in lockstep with the package they belong
  // to, so the dependency — pinned exactly — decides what gets embedded. A
  // range would mean guessing, and guessing wrong here ships a broken binary.
  const openTuiVersion = manifest.devDependencies?.["@opentui/core"];
  if (!openTuiVersion || !/^\d+\.\d+\.\d+/.test(openTuiVersion)) {
    fail(
      `${MANIFEST} must pin @opentui/core to an exact version, not ${JSON.stringify(openTuiVersion)}.\n` +
        `  The prebuilt native libraries this script fetches share that version number.`,
    );
  }

  return { manifest, scope, base, openTuiVersion };
}

/**
 * Puts the native package where the bundler will find it.
 *
 * Deliberately not `bun install`: npm's `os`/`cpu` fields mean only the *host's*
 * native package is ever installed, and the one a cross-build needs is by
 * definition a different one. It also sidesteps Bun's isolated layout, where the
 * host's copy lives in a `.bun/` directory that a cross-build has no business
 * resolving from. Placing it at the top level makes the build depend on the
 * registry rather than on which machine happens to be running it.
 */
async function ensureNative(name: string, version: string, file: string): Promise<string> {
  const dir = join(ROOT, "node_modules", ...name.split("/"));
  const marker = join(dir, "package.json");

  if (existsSync(marker)) {
    const installed = JSON.parse(await readFile(marker, "utf8")) as { version?: string };
    if (installed.version === version) return join(dir, file);

    // A stale version is worse than none: it would be embedded and shipped.
    await rm(dir, { recursive: true, force: true });
  }

  const registry = (process.env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const shortName = name.split("/")[1] ?? name;
  const url = `${registry}/${name}/-/${shortName}-${version}.tgz`;
  process.stdout.write(`  fetching ${name}@${version}\n`);

  const response = await fetch(url);
  if (!response.ok) {
    fail(`${name}@${version} is not on ${registry} (${response.status} ${response.statusText}).`);
  }

  const staging = await mkdtemp(join(tmpdir(), "tanuki-native-"));
  try {
    const tarball = join(staging, "package.tgz");
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
    // `tar` rather than a Bun API: there is no built-in extractor, and every
    // runner that can run Bun has a `tar`.
    const untar = spawnSync("tar", ["-xzf", tarball, "-C", staging], { encoding: "utf8" });
    if (untar.status !== 0) fail(`could not extract ${name}: ${untar.stderr.trim()}`);

    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await copyTree(join(staging, "package"), dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return join(dir, file);
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const result = spawnSync("cp", ["-R", from + "/.", to], { encoding: "utf8" });
  if (result.status !== 0) fail(`could not copy ${from} to ${to}: ${result.stderr.trim()}`);
}

/** The package directory for a target, from its committed manifest. */
async function packageDir(target: Target): Promise<string> {
  const source = await readManifest();
  const name = `${source.scope}/${source.base}-${target.id}`;
  const dir = join(ROOT, "packages", `${source.base}-${target.id}`);
  const marker = join(dir, "package.json");

  if (!existsSync(marker)) {
    fail(`${marker} is missing: every target needs a committed platform manifest.`);
  }

  const manifest = JSON.parse(await readFile(marker, "utf8")) as { name?: string; version?: string };
  if (manifest.name !== name) {
    fail(`${marker} declares ${JSON.stringify(manifest.name)} but should declare ${name}.`);
  }
  if (manifest.version !== source.manifest.version) {
    fail(
      `${marker} is at ${JSON.stringify(manifest.version)}, not the ${source.manifest.version} of\n` +
        `  ${MANIFEST}. Version bumps have to reach every platform package.`,
    );
  }

  return dir;
}

async function build(target: Target): Promise<void> {
  const source = await readManifest();
  const dir = await packageDir(target);
  const binaryPath = join(dir, "bin", target.binary);

  // `bin/` is not committed, so it may not exist on a fresh clone.
  await mkdir(dirname(binaryPath), { recursive: true });

  process.stdout.write(`\n${dir.replace(`${ROOT}/`, "")}\n`);
  const natives = await Promise.all(
    target.natives.map((name) => ensureNative(name, source.openTuiVersion, target.nativeFile)),
  );

  const built = spawnSync(
    "bun",
    ["build", ENTRY, "--compile", `--target=${target.bun}`, `--outfile=${binaryPath}`],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (built.status !== 0) fail(`bun build failed for ${target.id}`);

  // npm records the mode in the tarball and does not add one, so the file has to
  // be executable here or the shim's spawn fails on the user's machine.
  await chmod(binaryPath, 0o755);
  await verify(target, binaryPath, natives);
}

/**
 * Checks that the executable is the right shape *and* carries the target's
 * native library.
 *
 * The second half is the interesting one. It is what a cross-build cannot show
 * any other way: the library is inside the file, byte for byte, or it is not,
 * and a missing one would only surface as a crash on a machine we cannot run.
 */
async function verify(target: Target, binaryPath: string, natives: readonly string[]): Promise<void> {
  const binary = await readFile(binaryPath);
  const expected = MAGIC[target.format];
  const actual = [...binary.subarray(0, expected.length)];

  if (expected.some((byte, index) => actual[index] !== byte)) {
    fail(`${binaryPath} is not a ${target.format} executable (starts ${actual.join(" ")})`);
  }

  for (const native of natives) {
    const library = await readFile(native);
    // A slice from the middle: a header could plausibly appear by coincidence,
    // a run of interior bytes could not.
    const window = library.subarray(4096, 4096 + 64);

    if (binary.indexOf(window) === -1) {
      fail(
        `${target.id}: ${native.split("/").pop()} is not inside ${binaryPath}.\n` +
          `  The target's native library was not embedded, so this binary would fail at\n` +
          `  startup. Check that the OpenTUI version in packages/tanuki/package.json still\n` +
          `  matches the native packages this script fetches.`,
      );
    }
  }

  const megabytes = (binary.length / 1024 / 1024).toFixed(0);
  process.stdout.write(`  ok  ${target.format}, ${megabytes} MB, ${natives.length} native libraries embedded\n`);
}

function usage(): string {
  return [
    "usage: bun run scripts/build-platform.ts [--target <id>]...",
    "       bun run scripts/build-platform.ts --list | --matrix",
    "",
    "  --target <id>  build one platform (repeatable). Defaults to every target.",
    "  --list         print the target ids, one per line.",
    "  --matrix       print the release workflow's build matrix as JSON.",
    "",
    `targets: ${TARGETS.map((target) => target.id).join(", ")}`,
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const requested: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--target") {
      const value = argv[++index];
      if (!value) fail(`--target needs a value.\n\n${usage()}`);
      requested.push(value);
    } else if (argument === "--list") {
      process.stdout.write(`${TARGETS.map((target) => target.id).join("\n")}\n`);
      return 0;
    } else if (argument === "--matrix") {
      // The workflow reads this rather than repeating the table, so a target
      // added here cannot be quietly left out of a release.
      const include = TARGETS.map((target) => ({ target: target.id, runner: target.runner }));
      process.stdout.write(`${JSON.stringify({ include })}\n`);
      return 0;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else {
      fail(`unknown argument ${JSON.stringify(argument)}.\n\n${usage()}`);
    }
  }

  const wanted =
    requested.length === 0
      ? TARGETS
      : requested.map((id) => {
          const target = TARGETS.find((candidate) => candidate.id === id);
          if (!target) fail(`unknown target ${JSON.stringify(id)}.\n\n${usage()}`);
          return target;
        });

  for (const target of wanted) await build(target);

  process.stdout.write(`\n${wanted.length} platform(s) built\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
