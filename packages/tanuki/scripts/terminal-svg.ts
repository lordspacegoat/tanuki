/**
 * Renders a captured terminal frame to a standalone SVG "screenshot".
 *
 * The interface tests already assert on painted text; this turns the same
 * captured frame into an image so the README can show what the screens look
 * like without a human taking a screenshot by hand. Keeping it driven by
 * `captureSpans` means the picture is the real render — the same colours,
 * attributes and layout the renderer produced — rather than a mock-up.
 *
 * Two details matter for it to look like a terminal rather than a wall of text:
 *
 *  - the cell is drawn on a fixed grid. Character width is 0.6em, which is the
 *    advance width of every monospace face worth naming (Menlo, SF Mono, DejaVu,
 *    Liberation, Courier New), so a box-drawing border joins up instead of
 *    leaving hairlines.
 *  - it is deliberately font-independent: a stack of common monospace faces and
 *    no embedded webfont, so the file is small and renders anywhere.
 *
 * Colours come from the frame's own spans, not from the palette, so a capture
 * taken with the 256-colour fallback would look right too.
 */
import type { Frame } from "./frame-types.ts";

export interface SvgOptions {
  /** Shown in the window's title bar. */
  title: string;
  /** The terminal's own background, painted behind every cell. */
  background: string;
  /** Font size in user units. The cell is derived from it. */
  fontSize?: number;
  /** Rows and columns are a whole number of cells, so these must divide evenly. */
  lineHeight?: number;
}

/** Character advance as a fraction of the font size. 0.6 is the monospace norm. */
const CHAR_ASPECT = 0.6;
/** Terminal faces are the only ones in the stack for a reason: their metrics match. */
const FONT_STACK =
  `ui-monospace, "SF Mono", SFMono-Regular, Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace`;

const PADDING = 16;
const TITLE_BAR = 30;
const RADIUS = 10;
/** Breathing room so the window's corners and edge sit inside the image. */
const MARGIN = 14;

/** Text attributes are a bitfield (see @opentui/core `TextAttributes`). */
const BOLD = 1 << 0;
const DIM = 1 << 1;
const ITALIC = 1 << 2;
const UNDERLINE = 1 << 3;
const INVERSE = 1 << 5;
const HIDDEN = 1 << 6;
const STRIKETHROUGH = 1 << 7;

interface Run {
  text: string;
  /** Column the run starts at, in cells. */
  column: number;
  fg: string;
  fgOpacity: number;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

export function frameToSvg(frame: Frame, options: SvgOptions): string {
  const fontSize = options.fontSize ?? 14;
  const lineHeight = options.lineHeight ?? 20;
  const charWidth = round(fontSize * CHAR_ASPECT);

  const columns = frame.cols ?? widestLine(frame);
  const rows = frame.lines.length;

  const terminalWidth = columns * charWidth;
  const terminalHeight = rows * lineHeight;
  const width = terminalWidth + PADDING * 2;
  const height = terminalHeight + PADDING * 2 + TITLE_BAR;

  const body = frame.lines.map((line, index) => renderLine(line.spans, index * lineHeight, charWidth, lineHeight, options.background)).join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width + MARGIN * 2)}" height="${round(height + MARGIN * 2)}"`,
    ` viewBox="0 0 ${round(width + MARGIN * 2)} ${round(height + MARGIN * 2)}"`,
    ` font-family='${FONT_STACK}' font-size="${fontSize}" role="img"`,
    ` aria-label="${escapeAttribute(options.title)}">`,
    `<title>${escapeText(options.title)}</title>`,
    `<g transform="translate(${MARGIN}, ${MARGIN})">`,
    `<rect x="0" y="0" width="${round(width)}" height="${round(height)}" rx="${RADIUS}" fill="#150d24" stroke="#3a2358"/>`,
    `<circle cx="${PADDING + 8}" cy="${TITLE_BAR / 2}" r="5" fill="#f87171"/>`,
    `<circle cx="${PADDING + 26}" cy="${TITLE_BAR / 2}" r="5" fill="#fbbf24"/>`,
    `<circle cx="${PADDING + 44}" cy="${TITLE_BAR / 2}" r="5" fill="#a3e635"/>`,
    `<text x="${round(width / 2)}" y="${TITLE_BAR / 2 + 4}" text-anchor="middle" fill="#a99bc4" font-size="${fontSize - 1}">${escapeText(options.title)}</text>`,
    `<line x1="0" y1="${TITLE_BAR}" x2="${round(width)}" y2="${TITLE_BAR}" stroke="#3a2358"/>`,
    `<g transform="translate(${PADDING}, ${TITLE_BAR + PADDING})">`,
    `<rect x="0" y="0" width="${round(terminalWidth)}" height="${round(terminalHeight)}" fill="${options.background}"/>`,
    body,
    `</g>`,
    `</g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

function renderLine(spans: Frame["lines"][number]["spans"], y: number, charWidth: number, lineHeight: number, background: string): string {
  const runs = buildRuns(spans, background);
  const parts: string[] = [];

  for (const run of runs) {
    const x = round(run.column * charWidth);
    const baseline = round(y + lineHeight * 0.76);

    if (run.bg !== null) {
      parts.push(
        `<rect x="${x}" y="${round(y)}" width="${round(textColumns(run.text) * charWidth)}" height="${round(lineHeight)}" fill="${run.bg}"/>`,
      );
    }

    const text = run.text.replace(/ +$/, "");
    if (text.length === 0) continue;

    const decorations: string[] = [];
    if (run.underline) decorations.push("underline");
    if (run.strike) decorations.push("line-through");

    // `textLength` pins the run to its cells whatever font the viewer ends up
    // with: `spacingAndGlyphs` scales each glyph to fill its cell, so a
    // box-drawing border joins up and nothing runs off the right-hand edge. In
    // a face whose advance really is 0.6em this is an exact no-op.
    parts.push(
      `<text x="${x}" y="${baseline}" fill="${run.fg}"` +
        ` textLength="${round(textColumns(text) * charWidth)}" lengthAdjust="spacingAndGlyphs"` +
        (run.fgOpacity < 1 ? ` fill-opacity="${round(run.fgOpacity)}"` : "") +
        (run.bold ? ` font-weight="700"` : "") +
        (run.italic ? ` font-style="italic"` : "") +
        (decorations.length > 0 ? ` text-decoration="${decorations.join(" ")}"` : "") +
        ` xml:space="preserve">${escapeText(text)}</text>`,
    );
  }

  return parts.join("");
}

/**
 * Merges adjacent cells into runs, so a mostly-uniform row is a handful of
 * elements rather than one per cell. A run breaks whenever anything a reader
 * would see changes: the foreground, the background, or a text attribute.
 */
function buildRuns(spans: Frame["lines"][number]["spans"], background: string): Run[] {
  const runs: Run[] = [];
  let column = 0;

  for (const span of spans) {
    const width = span.width > 0 ? span.width : textColumns(span.text);
    const hidden = (span.attributes & HIDDEN) !== 0;
    const inverse = (span.attributes & INVERSE) !== 0;

    const fg = inverse ? span.bg : span.fg;
    const bg = inverse ? span.fg : span.bg;
    const [fr, fg2, fb, fa] = fg.toInts();
    const [br, bg2, bb, ba] = bg.toInts();
    const bgHex = toHex(br, bg2, bb);
    // The terminal's own background is painted once behind everything; a run
    // only needs its own rect where it actually differs.
    const bgColour = ba > 0 && bgHex.toLowerCase() !== background.toLowerCase() ? bgHex : null;

    const style = {
      fg: toHex(fr, fg2, fb),
      // A dim cell is rendered by the terminal at reduced intensity; folding it
      // into the fill's opacity keeps one field for "how bright is this text".
      fgOpacity: (fa / 255) * ((span.attributes & DIM) !== 0 ? 0.7 : 1),
      bg: bgColour,
      bold: (span.attributes & BOLD) !== 0,
      italic: (span.attributes & ITALIC) !== 0,
      underline: (span.attributes & UNDERLINE) !== 0,
      strike: (span.attributes & STRIKETHROUGH) !== 0,
    };

    const text = hidden ? "" : span.text;
    const previous = runs[runs.length - 1];

    if (previous && sameStyle(previous, style)) {
      previous.text += text;
    } else {
      runs.push({ text, column, ...style });
    }

    column += width;
  }

  return runs;
}

function sameStyle(run: Run, style: Omit<Run, "text" | "column">): boolean {
  return (
    run.fg === style.fg &&
    run.fgOpacity === style.fgOpacity &&
    run.bg === style.bg &&
    run.bold === style.bold &&
    run.italic === style.italic &&
    run.underline === style.underline &&
    run.strike === style.strike
  );
}

function widestLine(frame: Frame): number {
  let widest = 0;
  for (const line of frame.lines) {
    widest = Math.max(widest, textColumns(line.spans.map((span) => span.text).join("")));
  }
  return widest;
}

/** Code points, not bytes: the interface only ever paints one cell per glyph. */
function textColumns(text: string): number {
  return [...text].length;
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
