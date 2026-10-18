/**
 * One-line reports shown under a list.
 *
 * Screens disagree about almost everything, but they agree on this shape: a
 * sentence and whether it means the thing worked. Keeping it in one place means
 * the colour choice ("warn" versus "fine") is made once, by the screen that
 * renders it, from a single boolean.
 */
import type { PurgeSummary } from "../services/purge-service.ts";

export interface Notice {
  ok: boolean;
  text: string;
}

/**
 * The one-line report left on a list after a multi-zone purge closes. The
 * screen that ran the purge has already shown the detail; this is the trace
 * that survives it. Every wording here says **accepted**, never "purged".
 */
export function describePurgeSummary(summary: PurgeSummary): Notice {
  const zoneWord = summary.total === 1 ? "zone" : "zones";

  if (summary.cancelled) {
    return {
      ok: false,
      text: `Stopped early — Cloudflare accepted ${summary.accepted} of ${summary.total} ${zoneWord}. Requests already accepted cannot be recalled.`,
    };
  }
  if (summary.failed > 0) {
    return {
      ok: false,
      text: `Cloudflare accepted ${summary.accepted} of ${summary.total} ${zoneWord}; ${summary.failed} could not be purged.`,
    };
  }
  if (summary.skipped > 0) {
    return {
      ok: true,
      text: `Cloudflare accepted ${summary.accepted} of ${summary.total} ${zoneWord}; ${summary.skipped} skipped.`,
    };
  }
  if (summary.total === 1 && summary.accepted === 1) {
    return { ok: true, text: `Cloudflare accepted the purge for ${summary.outcomes[0]?.name ?? "the zone"}.` };
  }
  return { ok: true, text: `Cloudflare accepted all ${summary.total} ${zoneWord}.` };
}
