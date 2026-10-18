/**
 * The one list renderer (decision U2).
 *
 * Configurations, zones and groups are the same widget with different rows, so
 * they share one implementation rather than three that drift apart. Windowing,
 * the cursor marker and query highlighting all live here; the *rules* live in
 * `list-state.ts`, where they are tested without a renderer.
 *
 * Rows are painted from a window rather than inside a `scrollbox` so the cursor
 * position and the visible slice are computed the same way they are tested.
 */
import type { Segment } from "../list-state.ts";
import { segment, windowFor } from "../list-state.ts";
import { clip } from "../format.ts";
import type { Palette } from "../theme.ts";

export interface ListRow {
  key: string;
  /** Primary text. Searched, and highlighted when a query is active. */
  label: string;
  /** Trailing annotation, usually the stable identifier. */
  detail?: string;
  /** Right-hand marker such as a stale flag. */
  badge?: { text: string; colour: string };
  /** Painted instead of the usual row when the item needs a yes/no answer. */
  prompt?: string;
}

export interface ListViewProps {
  rows: readonly ListRow[];
  cursor: number;
  /** Rows available to paint. */
  height: number;
  query: string;
  /** Column width reserved for each row's label. */
  labelWidth: number;
  colours: Palette;
  emptyMessage: string;
}

export function ListView({
  rows,
  cursor,
  height,
  query,
  labelWidth,
  colours,
  emptyMessage,
}: ListViewProps) {
  if (rows.length === 0) {
    return (
      <box flexDirection="column">
        <text wrapMode="none" fg={colours.textDim}>
          {emptyMessage}
        </text>
      </box>
    );
  }

  const { start, end } = windowFor(cursor, rows.length, height);

  return (
    <box flexDirection="column">
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset;
        const active = index === cursor;

        if (row.prompt !== undefined) {
          return (
            <box key={row.key} flexDirection="row">
              <text wrapMode="none" fg={colours.amber}>
                {active ? "▶ " : "  "}
              </text>
              <text wrapMode="none" fg={colours.amber}>
                {row.prompt}
              </text>
            </box>
          );
        }

        return (
          <box key={row.key} flexDirection="row">
            <text wrapMode="none" fg={active ? colours.borderFocus : colours.textDim}>
              {active ? "▶ " : "  "}
            </text>
            <Highlighted
              text={row.label}
              query={query}
              width={labelWidth}
              baseColour={active ? colours.text : colours.textMuted}
              hitColour={colours.magenta}
            />
            {row.badge ? (
              <text wrapMode="none" fg={row.badge.colour}>
                {` ${row.badge.text}`}
              </text>
            ) : null}
            {row.detail ? (
              <text wrapMode="none" fg={colours.textDim}>
                {`  ${row.detail}`}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

/**
 * Paints a label with every occurrence of the query picked out.
 *
 * The label is clipped to `width` before padding, so a long name cannot push the
 * badge and the identifier out of their columns — the whole point of the label
 * column is that every row's annotation starts at the same place.
 */
export function Highlighted({
  text,
  query,
  width,
  baseColour,
  hitColour,
}: {
  text: string;
  query: string;
  width: number;
  baseColour: string;
  hitColour: string;
}) {
  const clipped = clip(text, width);
  const padded = clipped.length >= width ? clipped : clipped.padEnd(width);
  const parts: Segment[] = segment(padded, query);

  if (parts.length === 0) return <text wrapMode="none" fg={baseColour}>{" ".repeat(Math.max(0, width))}</text>;

  return (
    <text wrapMode="none">
      {parts.map((part, index) => (
        <span key={index} fg={part.hit ? hitColour : baseColour}>
          {part.text}
        </span>
      ))}
    </text>
  );
}
