/**
 * The tanuki: the face in the header, and the small one that runs along the
 * tagline occasionally (and every time a purge starts).
 *
 * Two rules make this safe to paint in a terminal:
 *
 *  - every line of the face is exactly `MASCOT_WIDTH` code points, and the
 *    runner is composed so the row it replaces keeps its width. A row that
 *    changes width would drag the header layout around twice a second.
 *  - only glyphs that are unambiguously one cell wide are used. The eyes are
 *    `•` and the nose is `ᴥ` — no emoji, no East-Asian-wide punctuation, no
 *    variation selectors.
 *
 * `mascotRows` is here rather than in `theme.ts` so the header's row budget and
 * the art that pays for it cannot disagree: the face is five rows against the
 * wordmark's two, and forgetting that is exactly how a list ends up painted over
 * its own hint line.
 */

/** The face. Five rows, all `MASCOT_WIDTH` wide, ears and chin included. */
export const MASCOT = [
  " ▄▄▄   ▄▄▄ ",
  "▐█████████▌",
  "▐█ •   • █▌",
  "▐█   ᴥ   █▌",
  " ▀▀▀▀▀▀▀▀▀ ",
] as const;

export const MASCOT_WIDTH = 11;
export const MASCOT_HEIGHT = MASCOT.length;

/**
 * The runner, mid-stride. Both frames are the same width, so alternating them
 * reads as movement rather than as a jitter.
 */
export const RUNNER_FRAMES = ["(^ᴥ^)", "(>ᴥ<)"] as const;
export const RUNNER_WIDTH = 5;

/**
 * One run's length in steps. Long enough for the sprite to cross a
 * `TAGLINE`-wide track (24 columns) and leave it on the right, so the row
 * returns to its resting state rather than freezing mid-crossing.
 */
export const RUNNER_STEPS = 40;

/**
 * Rows the face occupies — zero where it is not painted (decision U8: it
 * disappears on narrow terminals, and the tagline goes with it).
 */
export function mascotRows(shown: boolean): number {
  return shown ? MASCOT_HEIGHT : 0;
}

/** Alternate the frames so the sprite looks like it is moving. */
export function runnerFrame(step: number): string {
  return RUNNER_FRAMES[Math.abs(step) % RUNNER_FRAMES.length] ?? RUNNER_FRAMES[0];
}

export interface RunnerFrame {
  /** The base text before the sprite. */
  before: string;
  /** The visible slice of the sprite, or null while it is off the track. */
  sprite: string | null;
  /** The base text after the sprite. */
  after: string;
  /** True once the sprite has left the far end. */
  done: boolean;
}

/**
 * Places the sprite over `base` at `step`, sliding left to right.
 *
 * At step 0 the sprite sits just off the left edge; it walks across and off the
 * right, and `before + sprite + after` is always exactly `base.length` wide.
 */
export function runnerAt(step: number, base: string, sprite: string): RunnerFrame {
  const width = base.length;
  const offset = step - sprite.length;

  if (offset >= width) return { before: base, sprite: null, after: "", done: true };

  const start = Math.max(0, offset);
  const end = Math.min(width, offset + sprite.length);
  if (start >= end) return { before: base, sprite: null, after: "", done: false };

  return {
    before: base.slice(0, start),
    sprite: sprite.slice(start - offset, end - offset),
    after: base.slice(end),
    done: false,
  };
}
