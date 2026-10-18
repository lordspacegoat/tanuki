/**
 * Storage primitives (decision D6).
 *
 * Atomic writes and restrictive permissions. Nothing here knows about
 * configurations — it reads and writes text safely, and nothing else.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export class StorageError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** Creates the directory if needed and enforces 0700 on it. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is masked by umask and ignored when the directory exists, so
  // enforce it explicitly. Windows ignores this, hence the swallowed failure.
  try {
    await chmod(dir, DIR_MODE);
  } catch {
    /* not supported on this platform */
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write via a temporary file in the same directory and rename over the target.
 * A crash mid-write leaves the previous file intact rather than a truncated one.
 */
export async function writeFileAtomic(file: string, data: string, mode = FILE_MODE): Promise<void> {
  const dir = dirname(file);
  await ensureDir(dir);

  const tmp = join(dir, `.${basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "w", mode);

  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw new StorageError(`could not write ${file}`, error);
  }

  await handle.close();

  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new StorageError(`could not replace ${file}`, error);
  }

  try {
    await chmod(file, mode);
  } catch {
    /* not supported on this platform */
  }
}

/** Returns null when the file does not exist. Any other failure is a real error. */
export async function readFileIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new StorageError(`could not read ${file}`, error);
  }
}

export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Exposed for tests; not used by the application. */
export const ACCESS_EXISTS = constants.F_OK;
