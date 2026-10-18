#!/usr/bin/env node
/**
 * Node shim for Tanuki.
 *
 * The real application is a `bun build --compile` binary containing the Bun
 * runtime and the OpenTUI native library. npm can only fetch the matching one
 * via optionalDependencies, so this file's only job is to work out which
 * platform package was installed and hand over to it.
 *
 * Users of the published package need Node and nothing else — no Bun, no FFI
 * flags. This shim must stay dependency-free and CommonJS-free.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** platform-arch (plus libc tag on Linux) to npm package name. */
const TARGETS = {
  "darwin-arm64": "@kumokaizen/tanuki-darwin-arm64",
  "darwin-x64": "@kumokaizen/tanuki-darwin-x64",
  "linux-x64": "@kumokaizen/tanuki-linux-x64",
  "linux-arm64": "@kumokaizen/tanuki-linux-arm64",
  "linux-x64-musl": "@kumokaizen/tanuki-linux-x64-musl",
  "linux-arm64-musl": "@kumokaizen/tanuki-linux-arm64-musl",
  "win32-x64": "@kumokaizen/tanuki-win32-x64",
};

function isMusl() {
  // Alpine and other musl distros. Best-effort: the glibc build is the default
  // and musl is explicitly non-gating (see docs/DECISIONS.md F8).
  if (existsSync("/etc/alpine-release")) return true;
  if (process.env.OPENTUI_LIBC === "musl") return true;
  return false;
}

function targetPackage() {
  const { platform, arch } = process;
  if (platform === "linux") {
    return TARGETS[`linux-${arch}${isMusl() ? "-musl" : ""}`];
  }
  return TARGETS[`${platform}-${arch}`];
}

function binaryPath(pkg) {
  const pkgRoot = dirname(require.resolve(`${pkg}/package.json`));
  const name = process.platform === "win32" ? "tanuki.exe" : "tanuki";
  return join(pkgRoot, "bin", name);
}

function fail(message) {
  process.stderr.write(`tanuki: ${message}\n`);
  process.exit(1);
}

const pkg = targetPackage();

if (!pkg) {
  fail(
    `unsupported platform ${process.platform}/${process.arch}. ` +
      `Supported: macOS (arm64, x64) and Linux (x64, arm64); Windows x64 is best-effort.`,
  );
}

let binary;
try {
  binary = binaryPath(pkg);
} catch {
  fail(
    `the binary package ${pkg} was not installed.\n` +
      `  This usually means the install ran with --omit=optional, or that\n` +
      `  ${process.platform}/${process.arch} is not a published target yet.\n` +
      `  Reinstall with:  npm install -g @kumokaizen/tanuki`,
  );
}

if (!existsSync(binary)) {
  fail(`expected a binary at ${binary} but it is missing. Try reinstalling.`);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  fail(`failed to start the application: ${result.error.message}`);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
