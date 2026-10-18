/**
 * Configuration selector.
 *
 * Shown when more than one configuration exists and none was named on the
 * command line. Choosing one is the only way in; there is no implicit default,
 * because switching clients by accident is the failure mode worth avoiding.
 *
 * Three repairs live here as well, because this is where the client list is:
 * renaming a configuration (the display name only — the file and the credential
 * key are both the ID, so a rename can never orphan a token), replacing a
 * configuration's token, and deleting one. Deletion is the only irreversible
 * action in the whole interface: it takes the stored token with it, so it asks
 * with `y` and says what is lost.
 */
import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { clampCursor, moveCursor } from "../list-state.ts";
import { textOf } from "../keys.ts";
import { clip } from "../format.ts";
import type { Palette } from "../theme.ts";
import { space } from "../theme.ts";
import { Panel } from "../components/chrome.tsx";
import { ListView } from "../components/list.tsx";
import type { ListRow } from "../components/list.tsx";

export interface ConfigSelectProps {
  configs: ReadonlyArray<{ id: string; name: string }>;
  activeConfigId: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  /** Renames a configuration. Resolves to null, or to a sentence to show. */
  onRename: (id: string, name: string) => Promise<string | null>;
  /** Opens the token screen for an existing configuration. */
  onReplaceToken: (id: string) => void;
  /**
   * Deletes a configuration, its token and its zone list. Resolves to null, or
   * to a sentence to show. Nothing is deleted until this is called, and it is
   * only called from an answered confirmation.
   */
  onDelete: (id: string) => Promise<string | null>;
  colours: Palette;
  /** Rows available to the list, for windowing. */
  height: number;
}

/** The prompt that owns the keyboard while it is open. */
type Prompt =
  | { kind: "rename"; id: string; value: string }
  | { kind: "delete"; id: string };

export function ConfigSelect({
  configs,
  activeConfigId,
  onOpen,
  onCreate,
  onRename,
  onReplaceToken,
  onDelete,
  colours,
  height,
}: ConfigSelectProps) {
  const { width } = useTerminalDimensions();
  const [cursor, setCursor] = useState(() =>
    clampCursor(
      Math.max(0, configs.findIndex((config) => config.id === activeConfigId)),
      configs.length,
    ),
  );
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // A deletion can shorten the list under the cursor, so the row is clamped
  // rather than trusted; a cursor past the end would highlight nothing.
  const row = clampCursor(cursor, configs.length);
  const selected = configs[row] ?? null;
  const panelInner = Math.max(16, width - 6);

  const rows: ListRow[] = configs.map((config) => ({
    key: config.id,
    label: config.name,
    ...(config.id === activeConfigId ? { badge: { text: "active", colour: colours.lime } } : {}),
    ...(prompt?.kind === "delete" && config.id === prompt.id
      ? { prompt: `Delete ${config.name}? Its token is removed and cannot be recovered.  y / n` }
      : {}),
  }));

  const commitRename = async (target: Extract<Prompt, { kind: "rename" }>) => {
    if (busy) return;
    setBusy(true);
    const failure = await onRename(target.id, target.value);
    setBusy(false);
    // A rejected name is the common case — "already exists", "too long" — and it
    // belongs under the field, with what the user typed still there.
    if (failure !== null) setMessage(failure);
    else {
      setPrompt(null);
      setMessage(null);
    }
  };

  const commitDelete = async (target: Extract<Prompt, { kind: "delete" }>) => {
    if (busy) return;
    setBusy(true);
    const failure = await onDelete(target.id);
    setBusy(false);
    setPrompt(null);
    // A failure is worth stating even when the prompt closes, because the list
    // is unchanged and the user needs to know nothing happened.
    setMessage(failure);
  };

  useKeyboard((key) => {
    if (busy) return;

    if (prompt !== null) {
      if (prompt.kind === "delete") {
        if (key.name === "y") void commitDelete(prompt);
        else if (key.name === "n" || key.name === "escape" || key.name === "q") {
          setPrompt(null);
          setMessage(null);
        }
        return;
      }

      if (key.name === "escape") {
        setPrompt(null);
        setMessage(null);
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
        void commitRename(prompt);
        return;
      }
      if (key.name === "backspace") {
        setPrompt((current) =>
          current !== null && current.kind === "rename"
            ? { ...current, value: current.value.slice(0, -1) }
            : current,
        );
        return;
      }
      const text = textOf(key);
      if (text !== null) {
        setPrompt((current) =>
          current !== null && current.kind === "rename" ? { ...current, value: current.value + text } : current,
        );
      }
      return;
    }

    if (key.name === "up" || key.name === "k") setCursor((current) => moveCursor(current, -1, configs.length));
    else if (key.name === "down" || key.name === "j") setCursor((current) => moveCursor(current, 1, configs.length));
    else if (key.name === "n") onCreate();
    else if (key.name === "r" && selected) {
      setMessage(null);
      setPrompt({ kind: "rename", id: selected.id, value: selected.name });
    } else if (key.name === "t" && selected) onReplaceToken(selected.id);
    else if (key.name === "d" && selected) {
      setMessage(null);
      setPrompt({ kind: "delete", id: selected.id });
    } else if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      if (selected) onOpen(selected.id);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={space.sm}>
      <Panel colours={colours} focused title={clip(`Configurations · ${configs.length}`, panelInner)}>
        <box flexDirection="column" paddingTop={space.xs}>
          <ListView
            rows={rows}
            cursor={row}
            height={height}
            query=""
            labelWidth={Math.min(28, Math.max(16, panelInner - 26))}
            colours={colours}
            emptyMessage="No configurations yet. Press n to create one."
          />
        </box>
        <box flexGrow={1} />
        <box flexDirection="column" paddingBottom={space.xs} overflow="hidden" flexShrink={0}>
          {busy ? (
            <text wrapMode="none" fg={colours.cyan}>
              Saving…
            </text>
          ) : prompt?.kind === "rename" ? (
            <>
              <text wrapMode="none">
                <span fg={colours.textDim}>rename to: </span>
                <span fg={colours.magenta}>{clip(prompt.value, panelInner - 14)}</span>
                <span fg={colours.borderFocus}>▌</span>
              </text>
              {message !== null ? (
                <text wrapMode="none" fg={colours.red}>
                  {clip(message, panelInner)}
                </text>
              ) : (
                <text wrapMode="none" fg={colours.textDim}>
                  enter  save   ·   esc  discard
                </text>
              )}
            </>
          ) : prompt?.kind === "delete" ? (
            <text wrapMode="none" fg={colours.textDim}>
              y  delete   ·   n  keep
            </text>
          ) : message !== null ? (
            <text wrapMode="none" fg={colours.red}>
              {clip(message, panelInner)}
            </text>
          ) : (
            <text wrapMode="none" fg={colours.textDim}>
              {clip(
                "Each configuration keeps its own token, zones and groups. Press r to rename, t to replace its token, d to delete.",
                panelInner,
              )}
            </text>
          )}
        </box>
      </Panel>
    </box>
  );
}
