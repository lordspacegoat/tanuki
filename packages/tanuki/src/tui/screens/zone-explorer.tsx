/**
 * Zone explorer: the main screen.
 *
 * What this screen is responsible for:
 *
 *  - showing every zone the active configuration knows about, by name *and* by
 *    ID, because the ID is the stable identifier (decision D2);
 *  - search that filters as you type, highlights what matched, and restores the
 *    selection when you clear (decision U2);
 *  - a single-zone purge confirmed inline with `y`/`n` (decision U4);
 *  - a group or all-zone purge handed to the purge flow, which names the counted
 *    scope before anything is sent (decisions U4–U6);
 *  - reporting every result as **accepted**, never "purged" (decision C12) —
 *    Cloudflare acknowledging a request is not the same as the cache being gone
 *    — and showing Cloudflare's own reply alongside it;
 *  - refusing to purge anything stale, and saying why;
 *  - letting a zone be ignored (decision D8). An ignored zone is never purged
 *    and is hidden from the list until `i`, because deleting the row would only
 *    last until the next refresh brought it back.
 *
 * The list keeps its state (zones, selection, filter) while the purge flow is
 * open, because it renders in place rather than replacing this screen.
 */
import { useCallback, useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { CloudflareClient } from "../../cloudflare/client.ts";
import { userMessage } from "../../cloudflare/errors.ts";
import { isIgnored, refreshZones } from "../../cloudflare/zones.ts";
import type { RefreshChanges } from "../../cloudflare/zones.ts";
import { applyPurgeSummary, purgeZones } from "../../services/purge-service.ts";
import type { ZoneOutcome } from "../../services/purge-service.ts";
import type { PurgeScope } from "../../services/purge-scope.ts";
import type { TanukiConfig, ZoneRecord } from "../../config/schema.ts";
import { filterBy, indexOfKey, moveCursor } from "../list-state.ts";
import { textOf } from "../keys.ts";
import { clip, fitHint, formatMs, relativeTime } from "../format.ts";
import type { Palette, LayoutMode } from "../theme.ts";
import { space } from "../theme.ts";
import { Field, Panel, searchHint } from "../components/chrome.tsx";
import { ListView } from "../components/list.tsx";
import type { ListRow } from "../components/list.tsx";
import type { Notice } from "../notice.ts";
import { describePurgeSummary } from "../notice.ts";
import { usePurgeFlow } from "../use-purge-flow.tsx";

export interface ZoneExplorerProps {
  config: TanukiConfig;
  /** Built on demand so a purge always uses the credential as it stands now. */
  getClient: () => Promise<CloudflareClient>;
  onQuit: () => void;
  /**
   * Persists a reconciled zone list. Awaited, so a save failure can be reported
   * on screen rather than thrown into the void.
   */
  onZonesChanged: (zones: ZoneRecord[]) => Promise<void> | void;
  /** Opens the groups screen. */
  onOpenGroups: () => void;
  /** Opens the token screen to replace this configuration's token. */
  onReplaceToken: () => void;
  /** The header easter egg: a purge is about to start. */
  onPurgeStart?: () => void;
  /** Pushes this screen's own key hints up to the footer. */
  onHint?: (hint: string | null) => void;
  colours: Palette;
  mode: LayoutMode;
  /** Rows available to the list. */
  height: number;
}

/** The inline question a row can be waiting on. */
type Confirming = { id: string; action: "purge" | "ignore" };

const keyOfZone = (zone: ZoneRecord) => zone.id;

/**
 * Searched fields (decision U2: domain, group name, zone ID). Account name is
 * deliberately excluded: every zone in an account shares it, so including it
 * would make a search for the client's own name match the entire list.
 */
const zoneHaystack = (zone: ZoneRecord) => [zone.name, zone.id];

export function ZoneExplorer({
  config,
  getClient,
  onQuit,
  onZonesChanged,
  onOpenGroups,
  onReplaceToken,
  onPurgeStart,
  onHint,
  colours,
  mode,
  height,
}: ZoneExplorerProps) {
  const { width } = useTerminalDimensions();
  const [zones, setZones] = useState<readonly ZoneRecord[]>(config.zones);
  // Selection is tracked by zone ID rather than by row index. Two reasons: a
  // filter that hides the selected row must not silently slide the cursor onto a
  // different zone, and clearing the filter must put the cursor back where it was
  // (decision U2).
  const [selectedId, setSelectedId] = useState<string | null>(() => config.zones[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  // Re-renders once a minute so "just now" does not quietly become a lie.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const purge = usePurgeFlow({
    zones,
    groups: config.groups,
    purgeRate: config.prefs.purgeRate,
    getClient,
    colours,
    ...(onPurgeStart ? { onStart: onPurgeStart } : {}),
    onResult: (summary) => {
      const next = applyPurgeSummary(zones, summary);
      setZones(next);
      const report = describePurgeSummary(summary);
      void Promise.resolve()
        .then(() => onZonesChanged(next))
        .then(
          () => setNotice(report),
          (error: unknown) =>
            setNotice({
              ok: false,
              text: `The purge was sent, but the record could not be saved: ${userMessage(error)}`,
            }),
        );
    },
  });

  // The footer carries the global keys; while this screen is asking a question
  // of its own, it has nothing honest to add.
  const takenOver = purge.active || confirming !== null || searching;
  useEffect(() => {
    onHint?.(takenOver ? "" : null);
    return () => onHint?.(null);
  }, [onHint, takenOver]);

  const visible = showIgnored ? zones : zones.filter((zone) => !isIgnored(zone));
  const ignoredCount = zones.length - zones.filter((zone) => !isIgnored(zone)).length;
  const filtered = filterBy(visible, query, zoneHaystack);
  /** Row index of the selected zone within what is currently visible. */
  const view = Math.max(0, indexOfKey(filtered, selectedId, keyOfZone));
  const selected = filtered[view] ?? null;
  const detailVisible = mode === "two-column" || (mode === "single-column" && showDetail);

  const panelInner = Math.max(16, (mode === "two-column" ? Math.floor(width * 0.58) : width) - 4);
  const detailInner = Math.max(16, (mode === "two-column" ? Math.floor(width * 0.42) : width) - 4);

  const moveSelection = useCallback(
    (delta: number) => {
      const next = filtered[moveCursor(view, delta, filtered.length)];
      setSelectedId(next ? next.id : null);
    },
    [filtered, view],
  );

  /** Writes a new zone list, reporting a failed save rather than hiding it. */
  const persist = useCallback(
    async (next: readonly ZoneRecord[], ok: Notice, failureLabel: string) => {
      setZones(next);
      try {
        await onZonesChanged([...next]);
        setNotice(ok);
      } catch (error) {
        setNotice({ ok: false, text: `${failureLabel} ${userMessage(error)}` });
      }
    },
    [onZonesChanged],
  );

  const runPurge = useCallback(
    async (zone: ZoneRecord) => {
      setConfirming(null);
      setBusy(true);
      setNotice(null);
      onPurgeStart?.();
      try {
        const client = await getClient();
        const summary = await purgeZones(client, [zone]);
        const outcome = summary.outcomes[0];
        const report = outcome ? describeOutcome(outcome, zone.name) : { ok: false, text: "Nothing was purged." };
        await persist(applyPurgeSummary(zones, summary), report, "The purge was sent, but the record could not be saved:");
      } catch (error) {
        setNotice({ ok: false, text: userMessage(error, "purge") });
      } finally {
        setBusy(false);
      }
    },
    [getClient, onPurgeStart, persist, zones],
  );

  const toggleIgnore = useCallback(
    async (zone: ZoneRecord) => {
      setConfirming(null);
      setBusy(true);
      setNotice(null);

      const ignored = !isIgnored(zone);
      // Ignoring adds the flag; un-ignoring removes it rather than writing
      // `false`, so the saved zone carries only what is true about it.
      const next = zones.map((candidate) => {
        if (candidate.id !== zone.id) return candidate;
        if (ignored) return { ...candidate, ignored: true };
        const { ignored: _removed, ...rest } = candidate;
        return rest;
      });

      const report: Notice = ignored
        ? {
            ok: true,
            text: `${zone.name} is ignored. Press i to show ignored zones.`,
          }
        : { ok: true, text: `${zone.name} is no longer ignored.` };

      try {
        await persist(next, report, "The change could not be saved:");
      } catch (error) {
        setNotice({ ok: false, text: userMessage(error) });
      } finally {
        setBusy(false);
      }
    },
    [persist, zones],
  );

  /** Opens the multi-zone flow for a scope, or says why it cannot start. */
  const openScope = useCallback(
    (scope: PurgeScope) => {
      setNotice(null);
      const blocked = purge.open(scope);
      if (blocked !== null) setNotice({ ok: false, text: blocked });
    },
    [purge],
  );

  const runRefresh = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const client = await getClient();
      const result = await refreshZones(client, zones);
      // Persist before announcing success: a refresh the user believes was saved
      // but was not is worse than an error message.
      await persist(result.zones, { ok: true, text: describeChanges(result.changes) }, "The zones were re-read, but the change could not be saved:");
    } catch (error) {
      setNotice({ ok: false, text: userMessage(error, "list zones") });
    } finally {
      setBusy(false);
    }
  }, [getClient, persist, zones]);

  useKeyboard((key) => {
    // The purge flow owns every key while it is open. Both handlers are still
    // registered, so this one has to step aside rather than double-handle.
    if (purge.active) return;
    if (busy) return;

    // A confirmation captures every key: it is a yes/no question.
    if (confirming !== null) {
      if (key.name === "y") {
        const zone = zones.find((candidate) => candidate.id === confirming.id);
        if (zone) void (confirming.action === "purge" ? runPurge(zone) : toggleIgnore(zone));
      } else if (key.name === "n" || key.name === "escape") {
        setConfirming(null);
      }
      return;
    }

    if (searching) {
      if (key.name === "escape") {
        // Clearing the filter restores the previous selection (decision U2),
        // because the selection is held as a zone ID rather than a row index.
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
      case "q":
        onQuit();
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
      case "tab":
        if (mode === "single-column") setShowDetail((current) => !current);
        return;
      case "p":
        if (!selected) return;
        if (selected.stale !== undefined || isIgnored(selected)) {
          setNotice({ ok: false, text: notPurgeable(selected) });
          return;
        }
        setConfirming({ id: selected.id, action: "purge" });
        return;
      case "a":
        openScope({ kind: "all" });
        return;
      case "g":
        onOpenGroups();
        return;
      case "r":
        void runRefresh();
        return;
      case "i": {
        const next = !showIgnored;
        setShowIgnored(next);
        setNotice(
          ignoredCount === 0
            ? { ok: true, text: "No zones are ignored. Press x on one to leave it alone." }
            : {
                ok: true,
                text: next
                  ? `${ignoredCount} ignored ${ignoredCount === 1 ? "zone" : "zones"} shown — press x to stop ignoring one.`
                  : `${ignoredCount} ignored ${ignoredCount === 1 ? "zone" : "zones"} hidden.`,
              },
        );
        return;
      }
      case "x":
        if (!selected) return;
        if (isIgnored(selected)) {
          void toggleIgnore(selected);
          return;
        }
        setConfirming({ id: selected.id, action: "ignore" });
        return;
      case "t":
        onReplaceToken();
        return;
      default:
        return;
    }
  });

  const rows: ListRow[] = filtered.map((zone) => {
    const ignored = isIgnored(zone);
    return {
      key: zone.id,
      label: zone.name,
      detail: zone.id,
      ...(zone.stale
        ? { badge: { text: "stale", colour: colours.amber } }
        : ignored
          ? { badge: { text: "ignored", colour: colours.textDim } }
          : {}),
      ...(confirming?.id === zone.id
        ? {
            prompt:
              confirming.action === "purge"
                ? `Purge everything for ${zone.name}?  y / n`
                : `Ignore ${zone.name}? It stays on Cloudflare.  y / n`,
          }
        : {}),
    };
  });

  const listRows = rows;
  const hidden = ignoredCount > 0 && !showIgnored ? ` · ${ignoredCount} ignored` : "";

  return (
    <box flexDirection="row" flexGrow={1} paddingTop={space.xs}>
      {purge.node ?? (
        <>
          <Panel
            colours={colours}
            focused={mode === "compact" || !detailVisible}
            title={clip(
              `Zones · ${config.name} · ${filtered.length}${query.trim() ? ` of ${visible.length}` : ""}${hidden}`,
              panelInner,
            )}
            {...(detailVisible ? { width: "58%" } : {})}
          >
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

            <box flexDirection="column" paddingTop={space.xs} overflow="hidden">
              <ListView
                rows={listRows}
                cursor={view}
                height={height}
                query={query}
                labelWidth={Math.max(16, Math.min(34, Math.floor((mode === "two-column" ? 60 : 80) * 0.42)))}
                colours={colours}
                emptyMessage={
                  query.trim().length > 0
                    ? "Nothing matches that search."
                    : zones.length > 0 && !showIgnored
                      ? "Every zone here is ignored. Press i to show them."
                      : "No zones yet. Press r to fetch them from Cloudflare."
                }
              />
            </box>

            <box flexGrow={1} />

            <box flexDirection="column" paddingBottom={space.xs}>
              {busy ? (
                <text wrapMode="none" fg={colours.cyan}>
                  Working…
                </text>
              ) : notice !== null ? (
                <text wrapMode="none" fg={notice.ok ? colours.lime : colours.red}>
                  {clip(notice.text, panelInner)}
                </text>
              ) : searching ? (
                <text wrapMode="none" fg={colours.textDim}>
                  {searchHint(panelInner)}
                </text>
              ) : (
                <text wrapMode="none" fg={colours.textDim}>
                  {fitHint(panelInner, [
                    "p purge · a purge all · x ignore · i ignored · t replace token",
                    "p purge · a purge all · x ignore · t replace token",
                    "p purge · a purge all · x ignore",
                    "p purge · a purge all",
                  ])}
                </text>
              )}
            </box>
          </Panel>

          {detailVisible ? (
            <Detail
              zone={selected}
              colours={colours}
              now={now}
              width={detailInner}
            />
          ) : null}
        </>
      )}
    </box>
  );
}

function Detail({
  zone,
  colours,
  now,
  width,
}: {
  zone: ZoneRecord | null;
  colours: Palette;
  now: number;
  width: number;
}) {
  return (
    <box
      flexDirection="column"
      width="42%"
      border
      borderStyle="single"
      borderColor={colours.border}
      paddingX={1}
      overflow="hidden"
    >
      <text wrapMode="none" fg={colours.textDim}>
        Zone
      </text>
      {zone === null ? (
        <text wrapMode="none" fg={colours.textMuted}>
          Nothing selected.
        </text>
      ) : (
        <box flexDirection="column" paddingTop={space.xs}>
          <text wrapMode="none" fg={colours.text}>
            {clip(zone.name, width - 8)}
          </text>
          <text wrapMode="none"> </text>
          <Field colours={colours} label="id" value={clip(zone.id, width - 16)} />
          <Field colours={colours} label="status" value={zone.status} />
          <Field colours={colours} label="account" value={clip(zone.accountName ?? "unknown", width - 16)} />
          <Field colours={colours} label="plan" value={zone.planId ?? "unknown"} />
          <box flexDirection="column" paddingTop={space.xs}>
            <text wrapMode="none" fg={colours.textDim}>
              last purge
            </text>
            {lastPurgeLines(zone, now).map((line, index) => (
              <text
                key={index}
                wrapMode="none"
                fg={index > 0 ? colours.textMuted : zone.lastPurge?.ok === false ? colours.red : colours.text}
              >
                {clip(line, width - 2)}
              </text>
            ))}
          </box>
          {zone.stale ? (
            <box flexDirection="column" paddingTop={space.xs}>
              <text wrapMode="none" fg={colours.amber}>
                This zone is stale and will not be purged.
              </text>
              <text wrapMode="none" fg={colours.textMuted}>
                {clip(notPurgeable(zone), width)}
              </text>
            </box>
          ) : null}
          {isIgnored(zone) ? (
            <box flexDirection="column" paddingTop={space.xs}>
              <text wrapMode="none" fg={colours.amber}>
                This zone is ignored and will not be purged.
              </text>
              <text wrapMode="none" fg={colours.textMuted}>
                {clip(notPurgeable(zone), width)}
              </text>
            </box>
          ) : null}
        </box>
      )}
    </box>
  );
}

/** Cloudflare acknowledging a purge is not the cache being gone (decision C12). */
export function describeOutcome(outcome: ZoneOutcome, name: string): Notice {
  switch (outcome.status) {
    case "accepted": {
      // The purge id comes before the timing, because the notice is drawn in a
      // panel that is 58% wide on a wide terminal and clips from the right. What
      // survives a narrow screen should be the evidence, not the stopwatch.
      const parts = ["Cloudflare accepted"];
      if (outcome.acceptedId) parts.push(`id ${outcome.acceptedId}`);
      if (outcome.durationMs !== undefined) parts.push(formatMs(outcome.durationMs));
      return { ok: true, text: `${parts.join(" · ")}.` };
    }
    case "skipped":
      return { ok: false, text: `${name} was skipped — ${outcome.reason ?? "not attempted"}.` };
    default:
      return { ok: false, text: `${name} was not purged — ${outcome.reason ?? "unknown error"}.` };
  }
}

/**
 * When this zone was last purged, and whether it worked.
 *
 * Two lines, because the identifier Cloudflare returns is 32 characters and a
 * single `label: value` row would cut it. A failed attempt says so with its
 * reason rather than falling back to the previous success: the last thing that
 * happened is the useful answer.
 */
export function lastPurgeLines(zone: ZoneRecord, now: number): string[] {
  const record = zone.lastPurge;
  if (!record) return ["never"];

  const when = relativeTime(record.at, now);
  if (!record.ok) {
    return [`${when} · failed`, record.reason ? `reason: ${record.reason}` : "no reason was given"];
  }

  const detail = [record.purgeId ? `id ${record.purgeId}` : null, record.durationMs === undefined ? null : formatMs(record.durationMs)]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return [`${when} · accepted`, detail];
}

export function describeChanges(changes: RefreshChanges): string {
  const parts: string[] = [];
  if (changes.added.length > 0) parts.push(`${changes.added.length} new`);
  if (changes.updated.length > 0) parts.push(`${changes.updated.length} updated`);
  if (changes.restored.length > 0) parts.push(`${changes.restored.length} restored`);
  if (changes.stale.length > 0) parts.push(`${changes.stale.length} now stale`);
  return parts.length === 0 ? "Zones are up to date." : `Zones refreshed: ${parts.join(", ")}.`;
}

/**
 * Why this zone cannot be purged, as one short sentence.
 *
 * It is used twice: under a heading that has already named the problem ("This
 * zone is ignored and will not be purged."), and in the panel's one-line notice,
 * which is the tighter of the two. `Footer` is not the only thing with a column
 * budget — the explorer's notice line is 58% of a 100-column terminal, so 54
 * characters. Anything longer is clipped from the right, and what gets clipped
 * is the instruction at the end.
 */
export function notPurgeable(zone: ZoneRecord): string {
  if (isIgnored(zone)) return "Ignored by you. Press x to stop ignoring it.";
  switch (zone.stale?.reason) {
    case "gone":
      return "Gone from Cloudflare — there is nothing to purge.";
    case "not-permitted":
      return "This token cannot reach it — press t to replace it.";
    default:
      return "Not confirmed with Cloudflare. Press r to re-check.";
  }
}
