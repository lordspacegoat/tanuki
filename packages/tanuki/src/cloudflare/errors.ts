/**
 * Error taxonomy (decision §14).
 *
 * Cloudflare's numeric codes are the reliable signal; HTTP status is a weaker
 * one. Both are used, and everything user-facing goes through `userMessage`,
 * which is actionable, says what to do next, and never contains a credential.
 *
 * Codes handled, with what is known about them in the API docs:
 *   10000  authentication error
 *   9109   unauthorised to access requested resource (permission) — observed,
 *          not documented on a first-party page
 *   7003   no route for the URI / not found — used for unknown zone IDs
 *   1092   conflicting purge selectors
 *   1134   purge rate limit reached — docs show it under "4XX", not a pinned status
 */
import { redact } from "../services/redact.ts";
import type { ApiMessage, Envelope } from "./types.ts";

export type CloudflareErrorKind =
  | "auth"
  | "permission"
  | "not-found"
  | "rate-limit"
  | "validation"
  | "network"
  | "timeout"
  | "server"
  | "unknown";

export interface CloudflareErrorInit {
  kind: CloudflareErrorKind;
  message: string;
  status?: number;
  code?: number;
  retryAfterSeconds?: number;
  documentationUrl?: string;
  cause?: unknown;
}

export class CloudflareError extends Error {
  readonly kind: CloudflareErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly retryAfterSeconds?: number;
  readonly documentationUrl?: string;
  override readonly cause?: unknown;

  constructor(init: CloudflareErrorInit) {
    super(init.message);
    this.name = "CloudflareError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.documentationUrl = init.documentationUrl;
    this.cause = init.cause;
  }

  get isRateLimit(): boolean {
    return this.kind === "rate-limit";
  }

  /** How long to pause the account bucket, with a sane floor. */
  get retryAfterMs(): number {
    if (this.retryAfterSeconds !== undefined && Number.isFinite(this.retryAfterSeconds)) {
      return Math.max(1, Math.min(this.retryAfterSeconds, 300)) * 1000;
    }
    return 1_000;
  }
}

const CODE_KINDS: Record<number, CloudflareErrorKind> = {
  10000: "auth",
  9109: "permission",
  7003: "not-found",
  1092: "validation",
  1134: "rate-limit",
  1015: "rate-limit",
};

function kindFor(status: number, codes: readonly number[]): CloudflareErrorKind {
  for (const code of codes) {
    const kind = CODE_KINDS[code];
    if (kind) return kind;
  }

  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  if (status >= 400) return "validation";
  return "unknown";
}

export function errorFromResponse(
  status: number,
  envelope: Envelope<unknown> | null,
  retryAfterSeconds?: number,
): CloudflareError {
  const errors: ApiMessage[] = envelope?.errors ?? [];
  const first = errors[0];
  const codes = errors.map((error) => error.code);
  const kind = kindFor(status, codes);

  return new CloudflareError({
    kind,
    status,
    ...(first ? { code: first.code } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(first?.documentation_url ? { documentationUrl: first.documentation_url } : {}),
    message: first ? redact(first.message) : `Cloudflare returned HTTP ${status}.`,
  });
}

export function networkError(cause: unknown): CloudflareError {
  return new CloudflareError({
    kind: "network",
    message: "Could not reach api.cloudflare.com.",
    cause,
  });
}

export function timeoutError(ms: number): CloudflareError {
  return new CloudflareError({
    kind: "timeout",
    message: `api.cloudflare.com did not respond within ${Math.round(ms / 1000)}s.`,
  });
}

export function abortedError(): CloudflareError {
  return new CloudflareError({ kind: "network", message: "The request was cancelled." });
}

/**
 * What the user reads. Short, specific, and it names the remedy — an error the
 * user cannot act on is just noise.
 */
export function userMessage(error: unknown, action: "list zones" | "purge" | "verify" = "purge"): string {
  if (!(error instanceof CloudflareError)) {
    return redact(error instanceof Error ? error.message : String(error));
  }

  const permission =
    action === "list zones"
      ? "Zone → Zone → Read"
      : action === "purge"
        ? "Zone → Cache Purge → Purge"
        : "Zone → Zone → Read";

  switch (error.kind) {
    case "auth":
      return action === "verify"
        ? "Cloudflare rejected this token. It may be mistyped, expired, disabled or revoked. Create a new one with Zone → Zone → Read and Zone → Cache Purge → Purge."
        : "Cloudflare rejected the token. It may be expired, disabled or revoked. Replace it in this configuration's settings.";
    case "permission":
      return `This token cannot ${action} — it is missing ${permission}. Add that permission to the token in the Cloudflare dashboard.`;
    case "not-found":
      return "Cloudflare does not know that zone. It may have been deleted, or moved to another account.";
    case "rate-limit":
      return `Cloudflare is throttling ${action} requests for this account. Waiting briefly and retrying.`;
    case "validation":
      return `Cloudflare rejected the request: ${error.message}`;
    case "network":
      return "Could not reach api.cloudflare.com. Check your connection, then try again.";
    case "timeout":
      return "api.cloudflare.com did not respond in time. Try again.";
    case "server":
      return `Cloudflare had a server error (HTTP ${error.status ?? "5xx"}). This is usually temporary — try again shortly.`;
    default:
      return redact(error.message);
  }
}
