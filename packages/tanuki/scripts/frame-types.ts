/**
 * The slice of OpenTUI's captured-frame type this repository needs.
 *
 * Declared here rather than imported so the screenshot renderer depends on the
 * shape it actually reads — a span of text with a foreground, a background, a
 * column count and an attribute bitfield — instead of on a package's internal
 * type exports, which are not part of its public surface.
 */

export interface FrameColour {
  /** Returns `[r, g, b, a]`, each 0–255. */
  toInts(): [number, number, number, number];
}

export interface FrameSpan {
  text: string;
  fg: FrameColour;
  bg: FrameColour;
  /** Bitfield; see `TextAttributes` in `@opentui/core`. */
  attributes: number;
  /** Display columns the span occupies. */
  width: number;
}

export interface FrameLine {
  spans: FrameSpan[];
}

export interface Frame {
  cols: number;
  rows: number;
  lines: FrameLine[];
}
