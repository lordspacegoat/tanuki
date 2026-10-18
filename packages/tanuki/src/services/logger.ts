/**
 * Diagnostics (decision U9).
 *
 * An in-memory ring buffer always; a JSONL file only when TANUKI_LOG is set.
 * Every record passes through `redact` on the way in, so there is no path by
 * which a secret reaches the buffer, the file or the diagnostics panel.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redact, redactValue } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  at: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Ring buffer capacity. The diagnostics panel shows the last N. */
  capacity?: number;
  /** Enables the JSONL file. Normally set from TANUKI_LOG. */
  file?: string | null;
  minLevel?: LogLevel;
  clock?: () => string;
}

export class Logger {
  private readonly records: LogRecord[] = [];
  private readonly capacity: number;
  private readonly file: string | null;
  private readonly minLevel: LogLevel;
  private readonly clock: () => string;
  private fileReady = false;

  constructor(options: LoggerOptions = {}) {
    this.capacity = options.capacity ?? 500;
    this.file = options.file ?? null;
    this.minLevel = options.minLevel ?? "info";
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  debug(message: string, data?: unknown): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.write("error", message, data);
  }

  /** Oldest first. Used by the diagnostics panel. */
  entries(): readonly LogRecord[] {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const record: LogRecord = {
      at: this.clock(),
      level,
      message: redact(message),
      ...(data === undefined ? {} : { data: redactValue(data) }),
    };

    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }

    if (this.file) void this.appendToFile(record);
  }

  private async appendToFile(record: LogRecord): Promise<void> {
    try {
      if (!this.fileReady) {
        await mkdir(join(this.file!, ".."), { recursive: true });
        this.fileReady = true;
      }
      await appendFile(this.file!, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Diagnostics must never break the application. Give up quietly and stop
      // retrying: the ring buffer is still available.
      this.fileReady = false;
    }
  }
}

export function loggerFromEnv(env: NodeJS.ProcessEnv, logsDir: string): Logger {
  const enabled = env.TANUKI_LOG?.trim();
  const wantsFile = enabled === "debug" || enabled === "1" || enabled === "true";

  return new Logger({
    minLevel: enabled === "debug" ? "debug" : "info",
    file: wantsFile ? join(logsDir, "tanuki.log") : null,
  });
}
