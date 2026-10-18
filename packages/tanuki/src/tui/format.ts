/**
 * Text and time formatting for the interface.
 *
 * Two jobs, both about honesty on a fixed-width canvas:
 *
 *  - `clip` shortens a string to a column budget. Terminals wrap by default,
 *    and a wrapped row inside a panel grows the panel: that is how a long zone
 *    name ends up painted over the hint line underneath the list. Everything
 *    that must stay on one row is clipped *and* rendered with `wrapMode="none"`,
 *    so the layout holds even if a count here is wrong.
 *  - `formatMs` and `relativeTime` render durations and timestamps the way a
 *    person reads them. `relativeTime` deliberately degrades to a date rather
 *    than saying "3 months ago", which is less information, not more.
 *
 * Width is counted in code points, not cells. Zone names and group names are
 * ASCII in practice; a CJK name would clip a column or two early, which is the
 * harmless direction to be wrong in.
 */

export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  const characters = [...text];
  if (characters.length <= width) return text;
  if (width === 1) return "…";
  return `${characters.slice(0, width - 1).join("")}…`;
}

/**
 * The longest of `forms` that fits in `columns`, or the shortest if none does.
 *
 * For hint lines, where a cut sentence is worse than a shorter one: `clip` ends
 * `p purge · a purge all · x ignore · t repl…`, which teaches nothing about the
 * last key and looks like a bug. The caller writes the same hint out at two or
 * three lengths — longest first, all of them whole sentences — and the widest
 * that fits is used.
 */
export function fitHint(columns: number, forms: readonly string[]): string {
  for (const form of forms) {
    if ([...form].length <= columns) return form;
  }
  return forms[forms.length - 1] ?? "";
}

/** A round trip or a single request. Sub-second stays in milliseconds. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * "just now", "3 minutes ago", "2 hours ago", "5 days ago", or a plain date
 * once a date says more than a duration does.
 *
 * A timestamp in the future — a clock that moved, a file edited elsewhere —
 * reads as "just now" rather than "in 4 minutes".
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${count(minutes, "minute")} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${count(hours, "hour")} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${count(days, "day")} ago`;

  return new Date(then).toISOString().slice(0, 10);
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
