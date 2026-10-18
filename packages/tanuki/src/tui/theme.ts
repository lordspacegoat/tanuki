/**
 * Design tokens for the Tanuki interface.
 *
 * Decisions U7/U8: a flat accent palette derived from tokens, gradients painted
 * by hand in exactly two places (the header wordmark and the purge progress
 * bar), and a mascot that disappears on narrow terminals.
 *
 * OpenTUI supports 24-bit colour and RGBA-with-alpha, but has no gradient
 * primitive, so every gradient here is computed as a list of stops and painted
 * per-cell by a custom renderable. Terminals that only do 256 colours get a
 * quantised ramp from FALLBACK_256 instead.
 */

import { mascotRows } from "./mascot.ts";

export const palette = {
  /** Deep near-black base. */
  base: "#0b0714",
  surface: "#150d24",
  surfaceRaised: "#1f1235",
  border: "#3a2358",
  borderFocus: "#c026d3",

  text: "#f5f3ff",
  textMuted: "#a99bc4",
  textDim: "#6d5f8a",

  magenta: "#f0abfc",
  violet: "#a855f7",
  cyan: "#22d3ee",
  pink: "#ec4899",
  lime: "#a3e635",
  amber: "#fbbf24",
  red: "#f87171",
} as const;

/** 256-colour approximations, used when the terminal reports no true colour. */
export const fallback256 = {
  base: "#000000",
  surface: "#1c1c1c",
  surfaceRaised: "#262626",
  border: "#444444",
  borderFocus: "#d75fd7",
  text: "#eeeeee",
  textMuted: "#bcbcbc",
  textDim: "#767676",
  magenta: "#ffafff",
  violet: "#af87ff",
  cyan: "#5fd7d7",
  pink: "#ff5faf",
  lime: "#afff5f",
  amber: "#ffd75f",
  red: "#ff5f5f",
} as const satisfies Record<keyof typeof palette, string>;

export type PaletteKey = keyof typeof palette;

/** A resolved palette, either the true-colour one or its 256-colour fallback. */
export type Palette = Record<PaletteKey, string>;

export interface ColourCapabilities {
  /** Terminal reports 24-bit colour support. */
  rgb: boolean;
}

export function resolvePalette(caps: ColourCapabilities): Palette {
  return caps.rgb ? palette : fallback256;
}

/** The signature gradient, as stops. Painted by hand — there is no gradient primitive. */
export const signatureGradient = [
  palette.cyan,
  palette.violet,
  palette.magenta,
  palette.pink,
] as const;

/**
 * Progress-bar gradient, deliberately distinct from the wordmark. Held as
 * palette keys rather than literal colours so it resolves against whichever
 * palette is active: a 256-colour terminal gets a quantised ramp instead of
 * true-colour values it cannot show.
 */
export const progressGradientKeys = ["violet", "magenta", "pink"] as const satisfies readonly PaletteKey[];

export function progressStops(colours: Palette, steps: number): string[] {
  return gradientStops(
    progressGradientKeys.map((key) => colours[key]),
    steps,
  );
}

/**
 * Linear interpolation across a stop list, in sRGB. Returns one colour per step.
 * `paintGradient` hands these to the buffer API cell by cell.
 */
export function gradientStops(stops: readonly string[], steps: number): string[] {
  if (steps <= 0) return [];
  if (stops.length === 0) return [];
  if (stops.length === 1 || steps === 1) return new Array(steps).fill(stops[0]!);

  const rgb = stops.map(hexToRgb);
  const out: string[] = [];

  for (let i = 0; i < steps; i++) {
    const position = (i / (steps - 1)) * (rgb.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, rgb.length - 1);
    const t = position - lower;
    const a = rgb[lower]!;
    const b = rgb[upper]!;

    out.push(
      rgbToHex({
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t),
      }),
    );
  }

  return out;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Layout breakpoints (decision U1). The app is a two-column layout only on
 * genuinely wide terminals; below that it collapses in three stages, and below
 * the minimum it refuses rather than rendering something unreadable.
 */
export const breakpoints = {
  twoColumn: 100,
  singleColumn: 60,
  compact: 40,
  /**
   * Enough for the compact layout and its one-row list. The roomier layout
   * needs more, and degrades to compact rather than clipping itself.
   */
  minRows: 14,
  /**
   * Rows a list needs to still be worth showing. Below this the header's
   * mascot and tagline cost more than they give, so the layout goes compact
   * instead of leaving the list one row tall.
   */
  roomyRows: 20,
} as const;

export type LayoutMode = "two-column" | "single-column" | "compact" | "too-small";

export function layoutMode(width: number, height: number): LayoutMode {
  if (width < breakpoints.compact || height < breakpoints.minRows) return "too-small";
  if (width < breakpoints.singleColumn || height < breakpoints.roomyRows) return "compact";
  if (width < breakpoints.twoColumn) return "single-column";
  return "two-column";
}

/** The mascot is hidden below the single-column breakpoint (decision U8). */
export function showsMascot(mode: LayoutMode): boolean {
  return mode === "two-column" || mode === "single-column";
}

/** Rows the shared header takes: its own padding, then whichever column is
 * taller — the wordmark and its tagline, or the mascot's five rows. */
export function headerRows(mode: LayoutMode): number {
  // Compact drops the tagline, so the wordmark column is one row there.
  const wordmark = mode === "compact" ? 1 : 2;
  return 1 + Math.max(wordmark, mascotRows(showsMascot(mode)));
}

/** Rows the footer takes: its padding and its one line. */
export const FOOTER_ROWS = 2;

/**
 * Rows each screen spends before its list: the screen's own padding, the panel
 * border, its title, the search (or prompt) line, the list's top padding, and
 * the hint line underneath. Counted against the real components rather than
 * estimated — being a row under is how a list paints over the hint below it.
 *
 * The key is the screen's shape, not its name:
 *  - `list` is the zone explorer;
 *  - `panel` is a panel with a summary line above the list (groups, the
 *    configuration selector);
 *  - `editor` is the group editor, whose hint line can carry a "not saved yet"
 *    warning above the keys.
 */
export const screenRows = {
  list: 9,
  panel: 12,
  editor: 10,
} as const;

export type ScreenKind = keyof typeof screenRows;

/** Rows a screen must budget for the shared chrome and its own panel. */
export function chromeRows(mode: LayoutMode, screen: ScreenKind = "list"): number {
  return headerRows(mode) + FOOTER_ROWS + screenRows[screen];
}

/** Rows left for a screen's list once the chrome has been paid for. */
export function listRows(height: number, mode: LayoutMode, screen: ScreenKind = "list"): number {
  return Math.max(1, height - chromeRows(mode, screen));
}

/** Spacing scale. Nothing in the UI should use a raw pixel/row number. */
export const space = {
  xs: 1,
  sm: 2,
  md: 3,
  lg: 4,
  xl: 6,
} as const;
