/**
 * Redaction (decision S7).
 *
 * One chokepoint, applied at both boundaries: anything written to a log and
 * anything that ends up in an error message the user can see. If a secret can
 * reach the screen or the disk by another route, that is a bug — this function
 * is the only sanctioned path for text that might contain one.
 *
 * Cloudflare tokens have recognisable prefixes, which makes this reliable in
 * practice rather than best-effort. The bearer-header rule catches the case
 * where a token is well-formed but unusual.
 */

const REDACTED = "[redacted]";

const TOKEN_PATTERN = /\bcf(?:ut|at|k)_[A-Za-z0-9._-]{8,}/g;
const BEARER_PATTERN = /\b(bearer|authorization)\b["']?\s*[:=]?\s*["']?[A-Za-z0-9._~+/-]{8,}=*/gi;
const AUTH_HEADER_PATTERN = /("?(?:authorization|x-auth-key|x-auth-email)"?\s*:\s*")([^"]*)(")/gi;

export function redact(input: string): string {
  return input
    .replace(TOKEN_PATTERN, REDACTED)
    .replace(AUTH_HEADER_PATTERN, `$1${REDACTED}$3`)
    .replace(BEARER_PATTERN, (match) => {
      // Keep the scheme/label, drop the value: "Bearer [redacted]".
      const label = match.split(/[\s:=]/)[0] ?? "authorization";
      return `${label} ${REDACTED}`;
    });
}

/**
 * Deep redaction for structured data — log records, error causes, request
 * descriptions. Cycles and depth are bounded so this can never hang.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return "[depth limit]";

  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      ...(value.stack ? { stack: redact(value.stack) } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactValue(item, depth + 1, seen);
  }
  return out;
}

/**
 * Returns the token's prefix and last four characters for the user to
 * cross-check against the Cloudflare dashboard. This is a *display* allowance,
 * deliberately short: enough to identify a token, not enough to use one.
 *
 * Never returns more than eight characters.
 */
export function fingerprint(token: string): string {
  if (token.length <= 8) return "…";
  const prefix = token.slice(0, 4);
  const suffix = token.slice(-4);
  return `${prefix}…${suffix}`;
}

export const REDACTION_PLACEHOLDER = REDACTED;
