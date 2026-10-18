/**
 * Groups: named sets of zones, and the way in to a group purge (decisions D7, U3).
 *
 * This is the list half of group management — create, rename, delete, purge, and
 * open a group's membership. Membership itself is staged in `GroupEditor`,
 * because a checkbox list is a different shape of interaction from a list you
 * move through.
 *
 * Two rules show up in what the rows say:
 *
 *  - A member whose zone is stale is counted out of the number that would be
 *    sent, because a purge skips it. The row says how many *existing* zones a
 *    purge would reach (decisions C10), so the number here agrees with the
 *    confirmation screen rather than quietly contradicting it.
 *  - Deleting a group never touches a zone (decision D7). The confirmation says
 *    so, because "delete" next to "42 zones" reads like it might mean both.
 */
import { useCallback, useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { CloudflareClient } from "../../cloudflare/client.ts";
import { userMessage } from "../../cloudflare/errors.ts";
import { purgeableZones } from "../../cloudflare/zones.ts";
import {
  createGroup,
  deleteGroup,
  groupById,
  memberCount,
  renameGroup,
  setMembership,
  summarise,
} from "../../config/groups.ts";
import type { Group, TanukiConfig } from "../../config/schema.ts";
import { filterBy, indexOfKey, moveCursor } from "../list-state.ts";
import { textOf } from "../keys.ts";
import { clip, fitHint } from "../format.ts";
import type { LayoutMode, Palette } from "../theme.ts";
import { space } from "../theme.ts";
import { Field, Panel, searchHint } from "../components/chrome.tsx";
import { ListView } from "../components/list.tsx";
import type { ListRow } from "../components/list.tsx";
import type { Notice } from "../notice.ts";
import { describePurgeSummary } from "../notice.ts";
import { usePurgeFlow } from "../use-purge-flow.tsx";
import { GroupEditor } from "./group-editor.tsx";

export interface GroupsScreenProps {
  config: TanukiConfig;
  /** Built on demand so a purge always uses the credential as it stands now. */
  getClient: () => Promise<CloudflareClient>;
  /** Persists a new group list. Awaited, so a failed save is reported on screen. */
  onGroupsChanged: (groups: Group[]) => Promise<void> | void;
  /** Returns to the zone explorer. */
  onBack: () => void;
  /** The header easter egg: a purge is about to start. */
  onPurgeStart?: () => void;
  /** Pushes this screen's own key hints up to the footer. */
  onHint?: (hint: string | null) => void;
  colours: Palette;
  mode: LayoutMode;
  /** Rows available to the list. */
  height: number;
  /** Rows available to the membership editor, which spends two more than this
   * screen does on its own hint line. Defaults to `height`. */
  editorHeight?: number;
}

/** A name being typed. Held as a value so Esc and backspace need no extra state. */
type Prompt =
  | { mode: "create"; id: null; value: string }
  | { mode: "rename"; id: string; value: string };

const keyOfGroup = (group: Group) => group.id;
const groupHaystack = (group: Group) => [group.name];

export function GroupsScreen({
  config,
  getClient,
  onGroupsChanged,
  onBack,
  onPurgeStart,
  onHint,
  colours,
  mode,
  height,
  editorHeight,
}: GroupsScreenProps) {
  const { width } = useTerminalDimensions();
  const groups = config.groups;
  const zones = config.zones;

  const [selectedId, setSelectedId] = useState<string | null>(() => groups[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Counted against zones a purge would actually send for. A stale member is
  // still a member — the group keeps its IDs — but it is not one of the rows
  // this purge will reach, and the row has to agree with the confirmation.
  const purgeableIds = new Set(purgeableZones(zones).map((zone) => zone.id));
  const stats = summarise(zones.map((zone) => zone.id), groups);
  const editingGroup = editing === null ? null : (groupById(groups, editing) ?? null);
  const panelInner = Math.max(16, width - 4);

  const purge = usePurgeFlow({
    zones,
    groups,
    purgeRate: config.prefs.purgeRate,
    getClient,
    colours,
    ...(onPurgeStart ? { onStart: onPurgeStart } : {}),
    onResult: (summary) => setNotice(describePurgeSummary(summary)),
  });

  // The footer carries the global keys; while this screen is typing, editing or
  // asking a question, it has nothing honest to add.
  const takenOver =
    purge.active || editingGroup !== null || prompt !== null || confirmDelete !== null || searching;
  useEffect(() => {
    onHint?.(takenOver ? "" : null);
    return () => onHint?.(null);
  }, [onHint, takenOver]);

  const filtered = filterBy(groups, query, groupHaystack);
  const view = Math.max(0, indexOfKey(filtered, selectedId, keyOfGroup));
  const selected = filtered[view] ?? null;

  const moveSelection = useCallback(
    (delta: number) => {
      const next = filtered[moveCursor(view, delta, filtered.length)];
      setSelectedId(next ? next.id : null);
    },
    [filtered, view],
  );

  const commitPrompt = useCallback(async () => {
    if (prompt === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (prompt.mode === "create") {
        const created = createGroup(prompt.value, groups);
        await onGroupsChanged([...groups, created]);
        setSelectedId(created.id);
        setNotice({ ok: true, text: `Created ${created.name}. Press enter to choose its zones.` });
      } else {
        const next = renameGroup(groups, prompt.id, prompt.value);
        await onGroupsChanged(next);
        setSelectedId(prompt.id);
        setNotice({ ok: true, text: `Renamed to ${groupById(next, prompt.id)?.name ?? prompt.value}.` });
      }
      setPrompt(null);
    } catch (error) {
      // A rejected name is the common case — "already exists", "too long" — and
      // it belongs on the prompt line, with the text the user typed still there.
      setNotice({ ok: false, text: userMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, groups, onGroupsChanged, prompt]);

  const removeGroup = useCallback(
    async (id: string) => {
      const group = groupById(groups, id);
      const remaining = deleteGroup(groups, id);
      const index = groups.findIndex((candidate) => candidate.id === id);
      // Land on whatever took its place rather than leaving the cursor pointing
      // at a group that no longer exists.
      const next = remaining[Math.min(Math.max(0, index), Math.max(0, remaining.length - 1))];

      setConfirmDelete(null);
      setBusy(true);
      setNotice(null);
      try {
        await onGroupsChanged(remaining);
        setSelectedId(next?.id ?? null);
        setNotice({ ok: true, text: `Deleted ${group?.name ?? "the group"}. Its zones were not touched.` });
      } catch (error) {
        setNotice({ ok: false, text: userMessage(error) });
      } finally {
        setBusy(false);
      }
    },
    [groups, onGroupsChanged],
  );

  /** Opens the group purge, or says why it cannot start. */
  const openGroupScope = useCallback(
    (groupId: string) => {
      setNotice(null);
      const blocked = purge.open({ kind: "group", groupId });
      if (blocked !== null) setNotice({ ok: false, text: blocked });
    },
    [purge],
  );

  const applyMembership = useCallback(
    async (groupId: string, zoneIds: string[]) => {
      const group = groupById(groups, groupId);
      await onGroupsChanged(setMembership(groups, groupId, zoneIds));
      // Counted against existing zones only, so this reads the same as the row
      // it returns to (a stale member is a member the purge skips).
      const count = zoneIds.filter((id) => purgeableIds.has(id)).length;
      setEditing(null);
      setNotice({
        ok: true,
        text: `${group?.name ?? "Group"} now holds ${count} ${count === 1 ? "zone" : "zones"}.`,
      });
    },
    [groups, purgeableIds, onGroupsChanged],
  );

  useKeyboard((key) => {
    // The editor and the purge flow each own every key while they are open.
    if (purge.active || editingGroup !== null || busy) return;

    if (prompt !== null) {
      if (key.name === "escape") {
        setPrompt(null);
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
        void commitPrompt();
        return;
      }
      if (key.name === "backspace") {
        setPrompt((current) => (current === null ? current : { ...current, value: current.value.slice(0, -1) }));
        return;
      }
      const text = textOf(key);
      if (text !== null) {
        setPrompt((current) => (current === null ? current : { ...current, value: current.value + text }));
      }
      return;
    }

    if (confirmDelete !== null) {
      if (key.name === "y") void removeGroup(confirmDelete);
      else if (key.name === "n" || key.name === "escape") setConfirmDelete(null);
      return;
    }

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
      case "escape":
      case "q":
      case "g":
        onBack();
        return;
      case "/":
        setSearching(true);
        return;
      case "up":
      case "k":
        moveSelection(-1);
        return;
      case "down":
      case "j":
        moveSelection(1);
        return;
      case "return":
      case "enter":
      case "linefeed":
        if (selected) setEditing(selected.id);
        return;
      case "n":
        setNotice(null);
        setPrompt({ mode: "create", id: null, value: "" });
        return;
      case "r":
        if (selected) {
          setNotice(null);
          setPrompt({ mode: "rename", id: selected.id, value: selected.name });
        }
        return;
      case "d":
        if (selected) {
          setNotice(null);
          setConfirmDelete(selected.id);
        }
        return;
      case "p":
        if (selected) openGroupScope(selected.id);
        return;
      default:
        return;
    }
  });

  if (editingGroup !== null) {
    return (
      <box flexDirection="row" flexGrow={1} paddingTop={space.xs}>
        <GroupEditor
          key={editingGroup.id}
          group={editingGroup}
          zones={zones}
          groups={groups}
          colours={colours}
          mode={mode}
          height={editorHeight ?? height}
          onApply={(zoneIds) => applyMembership(editingGroup.id, zoneIds)}
          onCancel={() => setEditing(null)}
        />
      </box>
    );
  }

  const rows: ListRow[] = filtered.map((group) => {
    const count = memberCount(group, purgeableIds);
    return {
      key: group.id,
      label: group.name,
      detail: `${count} ${count === 1 ? "zone" : "zones"}`,
      ...(confirmDelete === group.id
        ? { prompt: `Delete ${group.name}? Its zones are not touched.  y / n` }
        : {}),
    };
  });

  const labelWidth = Math.max(16, Math.min(34, Math.floor((mode === "two-column" ? 60 : 80) * 0.42)));

  return (
    <box flexDirection="row" flexGrow={1} paddingTop={space.xs}>
      {purge.node ?? (
        <Panel
          colours={colours}
          focused
          title={clip(`Groups · ${config.name} · ${groups.length}`, panelInner)}
        >
          <box flexDirection="column" paddingTop={space.xs}>
            <text wrapMode="none" fg={colours.textDim}>
              {clip(
                `${stats.total} ${stats.total === 1 ? "zone" : "zones"} in this configuration · ${stats.ungrouped} ungrouped`,
                panelInner,
              )}
            </text>
          </box>

          {prompt !== null ? (
            <box flexDirection="column" paddingTop={space.xs}>
              <text wrapMode="none">
                <span fg={colours.textDim}>{prompt.mode === "create" ? "new group: " : "rename to: "}</span>
                <span fg={colours.magenta}>{clip(prompt.value, panelInner - 14)}</span>
                <span fg={colours.borderFocus}>▌</span>
              </text>
            </box>
          ) : (
            <box flexDirection="row" paddingTop={space.xs}>
              <text wrapMode="none" fg={colours.textDim}>
                /{" "}
              </text>
              <text wrapMode="none" fg={searching ? colours.borderFocus : colours.textMuted}>
                {query.length > 0 ? clip(query, panelInner - 4) : searching ? "" : "search"}
              </text>
              {searching ? (
                <text wrapMode="none" fg={colours.borderFocus}>
                  ▌
                </text>
              ) : null}
            </box>
          )}

          <box flexDirection="column" paddingTop={space.xs} overflow="hidden">
            <ListView
              rows={rows}
              cursor={view}
              height={height}
              query={query}
              labelWidth={labelWidth}
              colours={colours}
              emptyMessage={
                query.trim().length > 0
                  ? "Nothing matches that search."
                  : "No groups yet. Press n to create one."
              }
            />
          </box>

          <box flexGrow={1} />

          <box flexDirection="column" paddingBottom={space.xs} overflow="hidden">
            {busy ? (
              <text wrapMode="none" fg={colours.cyan}>
                Saving…
              </text>
            ) : notice !== null ? (
              <text wrapMode="none" fg={notice.ok ? colours.lime : colours.red}>
                {clip(notice.text, panelInner)}
              </text>
            ) : prompt !== null ? (
              <text wrapMode="none" fg={colours.textDim}>
                enter  save   ·   esc  discard
              </text>
            ) : searching ? (
              <text wrapMode="none" fg={colours.textDim}>
                {searchHint(panelInner)}
              </text>
            ) : (
              <>
                <Field
                  colours={colours}
                  label="Selected"
                  value={clip(
                    selected === null
                      ? "nothing"
                      : `${selected.name} · ${memberCount(selected, purgeableIds)} zones`,
                    panelInner - 14,
                  )}
                />
                <text wrapMode="none" fg={colours.textDim}>
                  {fitHint(panelInner, [
                    "enter edit · n new · p purge · r rename · d delete · esc back",
                    "enter edit · n new · p purge · r rename · esc back",
                    "enter edit · n new · p purge",
                    "enter edit · n new",
                  ])}
                </text>
              </>
            )}
          </box>
        </Panel>
      )}
    </box>
  );
}
