/**
 * Shared chrome: the wordmark, the footer and the size guard.
 *
 * The wordmark gradient is one of exactly two hand-painted gradients in the
 * interface (decision U7) — OpenTUI has no gradient primitive, so the stops are
 * computed here and painted per character.
 *
 * Every row here is painted with `wrapMode="none"`. A terminal wraps text by
 * default, and a wrapped row inside a fixed-height panel does not push anything
 * out of the way — it paints over whatever is underneath. Rows that must fit a
 * budget therefore clip instead, and the ones whose content can be arbitrary
 * (a hint line, a title, a label) are also clipped to a column count so the
 * reader gets an ellipsis rather than a word cut in half.
 */
import { useTerminalDimensions } from "@opentui/react";
import { clip, fitHint } from "../format.ts";
import { MASCOT, RUNNER_FRAMES, runnerAt, runnerFrame } from "../mascot.ts";
import { breakpoints, gradientStops, showsMascot, signatureGradient, space } from "../theme.ts";
import type { LayoutMode, Palette } from "../theme.ts";

const WORDMARK = "TANUKI";
const TAGLINE = "Cloudflare cache manager";
/** Frames are the same width, so the tagline row never changes size. */
const RUNNER_WIDTH = RUNNER_FRAMES[0].length;

export interface RunnerState {
  step: number;
  running: boolean;
}

export function Wordmark({
  colours,
  rgb,
  mode,
  run,
}: {
  colours: Palette;
  rgb: boolean;
  mode: LayoutMode;
  /** The header easter egg. Absent means it never runs. */
  run?: RunnerState;
}) {
  const painted = gradientStops(signatureGradient, WORDMARK.length);
  const mascot = showsMascot(mode);

  return (
    <box flexDirection="row" justifyContent="space-between" paddingTop={space.xs} flexShrink={0}>
      <box flexDirection="column">
        <text wrapMode="none">
          {[...WORDMARK].map((character, index) => (
            <span key={`${character}-${index}`} fg={rgb ? painted[index] : colours.magenta}>
              {character}
            </span>
          ))}
        </text>
        {mode === "compact" ? null : run ? (
          <Runner
            colours={colours}
            step={run.step}
            running={run.running}
            base={TAGLINE}
          />
        ) : (
          <text wrapMode="none" fg={colours.textMuted}>
            {TAGLINE.padEnd(TAGLINE.length + RUNNER_WIDTH)}
          </text>
        )}
      </box>
      {mascot ? (
        <box flexDirection="column">
          {MASCOT.map((line, index) => (
            <text key={index} wrapMode="none" fg={colours.violet}>
              {line}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  );
}

/**
 * The tagline row, with a small tanuki crossing it when a run is happening.
 *
 * The row keeps its width whatever the sprite is doing — `runnerAt` guarantees
 * `before + sprite + after` is exactly the base's width — so the header cannot
 * twitch while the easter egg plays.
 */
function Runner({
  colours,
  step,
  running,
  base,
}: {
  colours: Palette;
  step: number;
  running: boolean;
  base: string;
}) {
  const track = base.padEnd(base.length + RUNNER_WIDTH);
  const frame = runnerAt(running ? step : 0, track, runnerFrame(step));

  return (
    <text wrapMode="none" fg={colours.textMuted}>
      {frame.before}
      {frame.sprite === null ? null : <span fg={colours.pink}>{frame.sprite}</span>}
      {frame.after}
    </text>
  );
}

export function Footer({
  colours,
  mode,
  hints,
}: {
  colours: Palette;
  mode: LayoutMode;
  /** Full hint line. The caller already knows which form fits. */
  hints: string;
}) {
  const { width } = useTerminalDimensions();
  // "made with ♥" and the panel's own padding claim the right-hand side. A
  // clipped hint is better than a wrapped one, which would push the footer off
  // the bottom of the screen.
  const shown = clip(hints, Math.max(8, width - 20));

  return (
    <box flexDirection="row" justifyContent="space-between" paddingTop={space.xs} flexShrink={0}>
      <text wrapMode="none" fg={colours.textDim}>
        {shown}
      </text>
      {/* `♥` rather than the ❤️ emoji: an emoji is double-width, and a
          double-width glyph here would push the hint line out of alignment. */}
      <text wrapMode="none" fg={colours.textDim}>
        made with <span fg={colours.pink}>♥</span>
      </text>
    </box>
  );
}

export function TooSmall({ width, height, colours }: { width: number; height: number; colours: Palette }) {
  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} backgroundColor={colours.base}>
      <text wrapMode="none" fg={colours.text}>
        Terminal too small
      </text>
      <text wrapMode="none" fg={colours.textMuted}>
        need {breakpoints.compact}×{breakpoints.minRows} · have {width}×{height}
      </text>
    </box>
  );
}

/**
 * The hint for a search field that owns the keyboard.
 *
 * Three screens show this line — the zone explorer, the group list and the group
 * editor — and each sits in a panel of a different width, so it lives here
 * rather than being written out three times. The short forms are whole
 * sentences: at 40 columns there is room for `type to filter` and not for
 * `esc to clear`, and a cut `esc to clea…` is worse than an omitted key.
 */
export function searchHint(columns: number): string {
  return fitHint(columns, [
    "type to filter · enter to keep · esc to clear",
    "type to filter · enter keep · esc clear",
    "type to filter · enter keep",
    "type to filter",
  ]);
}

/** A bordered content panel. The border colour carries focus, not decoration. */
export function Panel({
  colours,
  children,
  title,
  focused = false,
  flexGrow,
  width,
}: {
  colours: Palette;
  children: React.ReactNode;
  title?: string;
  focused?: boolean;
  /** Ignored when `width` is given. */
  flexGrow?: number;
  /**
   * A fixed or percentage width. Used where two panels sit side by side: flex
   * alone lets a single long, unbreakable line in one panel squeeze the other.
   */
  width?: number | `${number}%`;
}) {
  return (
    <box
      flexDirection="column"
      flexGrow={width === undefined ? (flexGrow ?? 1) : undefined}
      width={width}
      border
      borderStyle="single"
      borderColor={focused ? colours.borderFocus : colours.border}
      backgroundColor={colours.base}
      paddingX={1}
      // The last line of defence for the row budget: whatever happens inside,
      // nothing paints over the hint line or the footer underneath.
      overflow="hidden"
    >
      {title ? (
        <text wrapMode="none" fg={colours.textDim}>
          {title}
        </text>
      ) : null}
      {children}
    </box>
  );
}

/** A left-aligned label/value row, so panels line up without ad-hoc padding. */
export function Field({
  colours,
  label,
  value,
  labelWidth = 14,
  valueColour,
}: {
  colours: Palette;
  label: string;
  value: string;
  labelWidth?: number;
  valueColour?: string;
}) {
  return (
    <text wrapMode="none">
      <span fg={colours.textDim}>{clip(label.padEnd(labelWidth), labelWidth)}</span>
      <span fg={valueColour ?? colours.text}>{value}</span>
    </text>
  );
}
