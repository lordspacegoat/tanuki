/**
 * Group membership editor (decision U3).
 *
 * A full-screen checkbox list with staged edits and an explicit Apply. Nothing
 * is written until Apply, and Apply is the only thing that writes — so Esc
 * cancels by construction rather than by undoing anything.
 *
 * Staged edits are held as a set of zone IDs, seeded from the group's *whole*
 * membership rather than from the zones currently listed. A member the list does
 * not show is therefore preserved, instead of being silently dropped by an Apply
 * that never had the chance to display it.
 *
 * Checkbox state deliberately shows what the *other* groups hold as well, so
 * assigning a zone here cannot quietly remove it from somewhere else — groups
 * are not exclusive (decision D7). Stale and ignored members say so too, because
 * ticking one changes what a purge will reach even though the membership count
 * does not move.
 */
import { useCallback, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { userMessage } from "../../cloudflare/errors.ts";
import { isIgnored } from "../../cloudflare/zones.ts";
import type { Group, ZoneRecord } from "../../config/schema.ts";
import { membershipLabels } from "../../config/groups.ts";
import { filterBy, indexOfKey, moveCursor, windowFor } from "../list-state.ts";
import { textOf } from "../keys.ts";
import { clip } from "../format.ts";
import type { LayoutMode, Palette } from "../theme.ts";
import { space } from "../theme.ts";
import { Panel, searchHint } from "../components/chrome.tsx";
import { Highlighted } from "../components/list.tsx";
import type { Notice } from "../notice.ts";

export interface GroupEditorProps {
  group: Group;
  zones: readonly ZoneRecord[];
  /** Every group, so a row can name the other groups that already hold the zone. */
  groups: readonly Group[];
  colours: Palette;
  mode: LayoutMode;
  /** Rows available to the list. */
  height: number;
  /** Commits the new membership. Awaited, so a failed save is reported here. */
  onApply: (zoneIds: string[]) => Promise<void> | void;
  onCancel: () => void;
}

const keyOfZone = (zone: ZoneRecord) => zone.id;
const zoneHaystack = (zone: ZoneRecord) => [zone.name, zone.id];

export function GroupEditor({
  group,
  zones,
  groups,
  colours,
  mode,
  height,
  onApply,
  onCancel,
}: GroupEditorProps) {
  const { width } = useTerminalDimensions();
  const [staged, setStaged] = useState<ReadonlySet<string>>(() => new Set(group.zoneIds));
  // Keyed by zone ID for the same reason the explorer is: a filter must not be
  // able to slide the cursor onto a different zone (decision U2).
  const [selectedId, setSelectedId] = useState<string | null>(() => zones[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const original = new Set(group.zoneIds);
  const added = [...staged].filter((id) => !original.has(id));
  const removed = [...original].filter((id) => !staged.has(id));
  const changes = added.length + removed.length;

  const filtered = filterBy(zones, query, zoneHaystack);
  const view = Math.max(0, indexOfKey(filtered, selectedId, keyOfZone));
  const selected = filtered[view] ?? null;
  // Counted over the zones this screen can show. A staged ID with no zone here
  // (a member whose zone the list has never held) is still preserved by Apply,
  // but counting it would print "3 of 2 selected", which reads as a bug.
  const checkedCount = zones.filter((zone) => staged.has(zone.id)).length;
  const panelInner = Math.max(16, width - 4);

  const moveSelection = useCallback(
    (delta: number) => {
      const next = filtered[moveCursor(view, delta, filtered.length)];
      setSelectedId(next ? next.id : null);
    },
    [filtered, view],
  );

  const toggle = useCallback((zoneId: string) => {
    setStaged((current) => {
      const next = new Set(current);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

  const apply = useCallback(async () => {
    if (busy || changes === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      await onApply([...staged]);
    } catch (error) {
      // Stay in the editor, holding the staged state: a failed save must not
      // look like a successful one, and must not throw the edits away.
      setNotice({ ok: false, text: userMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, changes, onApply, staged]);

  useKeyboard((key) => {
    if (busy) return;

    if (searching) {
      if (key.name === "escape") {
        setQuery("");
        setSearching(false);
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
        setSearching(false);
        return;
      }
      if (key.name === "backspace") {
        setQuery((current) => current.slice(0, -1));
        return;
      }
      const text = textOf(key);
      if (text !== null) setQuery((current) => current + text);
      return;
    }

    switch (key.name) {
      case "space":
      case " ": // some terminals report the literal character for space
        if (selected) toggle(selected.id);
        return;
      case "a":
        void apply();
        return;
      case "escape":
      case "q":
        onCancel();
        return;
      case "up":
      case "k":
        moveSelection(-1);
        return;
      case "down":
      case "j":
        moveSelection(1);
        return;
      case "/":
        setSearching(true);
        return;
      default:
        return;
    }
  });

  const { start, end } = windowFor(view, filtered.length, height);
  const labelWidth = Math.max(16, Math.min(34, Math.floor((mode === "two-column" ? 60 : 80) * 0.42)));

  return (
    <Panel
      colours={colours}
      focused
      title={clip(
        `Group · ${group.name} · ${checkedCount} of ${zones.length} selected${changes > 0 ? ` · ${changes} unsaved` : ""}`,
        panelInner,
      )}
    >
      <box flexDirection="row" paddingTop={space.xs}>
        <text wrapMode="none" fg={colours.textDim}>
          /{" "}
        </text>
        <text wrapMode="none" fg={searching ? colours.borderFocus : colours.textMuted}>
          {query.length > 0 ? clip(query, panelInner - 4) : searching ? "" : "filter"}
        </text>
        {searching ? (
          <text wrapMode="none" fg={colours.borderFocus}>
            ▌
          </text>
        ) : null}
      </box>

      <box flexDirection="column" paddingTop={space.xs} overflow="hidden">
        {filtered.length === 0 ? (
          <text wrapMode="none" fg={colours.textDim}>
            {query.trim().length > 0 ? "Nothing matches that filter." : "No zones to choose from."}
          </text>
        ) : (
          filtered.slice(start, end).map((zone, offset) => {
            const index = start + offset;
            const active = index === view;
            const checked = staged.has(zone.id);
            const also = membershipLabels(groups, zone.id, group.id);

            return (
              <box key={zone.id} flexDirection="row">
                <text wrapMode="none" fg={active ? colours.borderFocus : colours.textDim}>
                  {active ? "▶ " : "  "}
                </text>
                <text wrapMode="none" fg={checked ? colours.lime : colours.textDim}>
                  {checked ? "[x] " : "[ ] "}
                </text>
                <Highlighted
                  text={zone.name}
                  query={query}
                  width={labelWidth}
                  baseColour={active ? colours.text : colours.textMuted}
                  hitColour={colours.magenta}
                />
                {zone.stale ? (
                  <text wrapMode="none" fg={colours.amber}>
                    {" "}
                    stale
                  </text>
                ) : null}
                {isIgnored(zone) ? (
                  <text wrapMode="none" fg={colours.textDim}>
                    {" "}
                    ignored
                  </text>
                ) : null}
                {also.length > 0 ? (
                  <text wrapMode="none" fg={colours.textDim}>
                    {clip(`  also in ${also.join(", ")}`, Math.max(0, panelInner - labelWidth - 12))}
                  </text>
                ) : null}
                <text wrapMode="none" fg={colours.textDim}>
                  {`  ${zone.id}`}
                </text>
              </box>
            );
          })
        )}
      </box>

      <box flexGrow={1} />

      <box flexDirection="column" paddingBottom={space.xs} overflow="hidden">
        {busy ? (
          <text wrapMode="none" fg={colours.cyan}>
            Saving…
          </text>
        ) : notice !== null ? (
          <text wrapMode="none" fg={colours.red}>
            {clip(notice.text, panelInner)}
          </text>
        ) : searching ? (
          <text wrapMode="none" fg={colours.textDim}>
            {searchHint(panelInner)}
          </text>
        ) : (
          <>
            {changes > 0 ? (
              <text wrapMode="none" fg={colours.amber}>
                {`${changes} change${changes === 1 ? "" : "s"} not saved yet`}
              </text>
            ) : null}
            <text wrapMode="none" fg={colours.textDim}>
              space  toggle   ·   /  filter   ·   a  apply   ·   esc  discard
            </text>
          </>
        )}
      </box>
    </Panel>
  );
}
