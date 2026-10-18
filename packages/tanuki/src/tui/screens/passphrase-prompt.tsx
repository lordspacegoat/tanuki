/**
 * The passphrase prompt.
 *
 * A whole screen rather than an overlay, deliberately. OpenTUI delivers every
 * keypress to every registered handler, so a panel floating over the zone list
 * would still let `/` start a search and `q` quit while the user was typing
 * their passphrase. Replacing the screen is the same choice the purge
 * confirmation makes, and it makes the keyboard unambiguous for free.
 *
 * The field is masked for the same reason the token field is (decision S7):
 * only the length is ever painted, and there is no reveal toggle. A passphrase
 * typed on a screen someone else can see does not need one.
 */
import { useState } from "react";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { decodePasteBytes } from "@opentui/core";
import { clip } from "../format.ts";
import {
  checkNewPassphrase,
  emptyPassphrase,
  maskedPassphrase,
  passphraseActionForKey,
  reducePassphrase,
  MAX_PASSPHRASE_LENGTH,
  MIN_PASSPHRASE_LENGTH,
} from "../passphrase-entry.ts";
import type { PassphraseField } from "../passphrase-entry.ts";
import type { LayoutMode, Palette } from "../theme.ts";
import { space } from "../theme.ts";
import { Panel } from "../components/chrome.tsx";

export interface PassphrasePromptProps {
  reason: "unlock" | "create";
  /**
   * What is being unlocked, when it is known. A vault is addressed by the
   * configuration's ID, so the caller looks the name up rather than the
   * credential store having to carry it.
   */
  subject?: string | null;
  /** The previous attempt's failure, when this is a retry. */
  error?: string | null;
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
  colours: Palette;
}

export function PassphrasePrompt({
  reason,
  subject,
  error = null,
  onSubmit,
  onCancel,
  colours,
}: PassphrasePromptProps) {
  const { width } = useTerminalDimensions();
  const creating = reason === "create";

  const [passphrase, setPassphrase] = useState<PassphraseField>(emptyPassphrase);
  const [confirmation, setConfirmation] = useState<PassphraseField>(emptyPassphrase);
  const [focus, setFocus] = useState<0 | 1>(0);
  const [message, setMessage] = useState<string | null>(null);

  const inner = Math.max(16, width - 6);
  const onConfirmField = creating && focus === 1;

  const advance = () => {
    if (!creating) {
      if (passphrase.value.length > 0) onSubmit(passphrase.value);
      return;
    }

    if (focus === 0) {
      if (passphrase.value.length < MIN_PASSPHRASE_LENGTH) {
        setMessage(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
        return;
      }
      setMessage(null);
      setFocus(1);
      return;
    }

    const check = checkNewPassphrase(passphrase.value, confirmation.value);
    if (!check.ok) setMessage(check.message);
    else onSubmit(passphrase.value);
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.name === "tab") {
      if (creating) setFocus((current) => (current === 0 ? 1 : 0));
      return;
    }

    const action = passphraseActionForKey(key);
    if (action.type === "submit") {
      advance();
      return;
    }
    if (action.type === "ignore") return;

    setMessage(null);
    const apply = onConfirmField ? setConfirmation : setPassphrase;
    apply((current) => reducePassphrase(current, action));
  });

  usePaste((event) => {
    // PasteEvent carries bytes, not text; decoding is the documented path.
    const text = decodePasteBytes(event.bytes);
    setMessage(null);
    const apply = onConfirmField ? setConfirmation : setPassphrase;
    apply((current) => reducePassphrase(current, { type: "insert", text }));
  });

  // A local validation message outranks the store's: it describes something the
  // user can fix on *this* screen, and it is the more recent answer.
  const detail = message ?? error;

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={space.sm}>
      <Panel colours={colours} focused title={clip(creating ? "New passphrase" : titleFor(subject), inner)}>
        <box flexDirection="column" paddingTop={space.xs}>
          <text wrapMode="none" fg={colours.textMuted}>
            {clip(
              creating
                ? "Your token is sealed with this passphrase. It is stored nowhere, so it cannot be recovered."
                : "The token for this configuration is in an encrypted file.",
              inner,
            )}
          </text>
        </box>

        <Field
          colours={colours}
          label="Passphrase"
          field={passphrase}
          width={inner}
          active={!onConfirmField}
        />

        {creating ? (
          <Field
            colours={colours}
            label="Confirm"
            field={confirmation}
            width={inner}
            active={onConfirmField}
          />
        ) : null}

        <box flexGrow={1} />

        {detail !== null ? (
          <text wrapMode="none" fg={colours.red}>
            {clip(detail, inner)}
          </text>
        ) : (
          <text wrapMode="none" fg={colours.textDim}>
            {creating ? clip(`Use at least ${MIN_PASSPHRASE_LENGTH} characters, and type it twice.`, inner) : " "}
          </text>
        )}

        {/* flexShrink 0: the prose above gives up rows before the keys do. */}
        <box flexDirection="column" paddingBottom={space.xs} flexShrink={0}>
          <text wrapMode="none" fg={colours.magenta}>
            {creating
              ? focus === 0
                ? "enter  next"
                : "enter  save"
              : "enter  unlock"}
          </text>
          <text wrapMode="none" fg={colours.textDim}>
            esc  cancel
          </text>
        </box>
      </Panel>
    </box>
  );
}

function titleFor(subject: string | null | undefined): string {
  return subject ? `Unlock ${subject}` : "Passphrase";
}

function Field({
  colours,
  label,
  field,
  width,
  active,
}: {
  colours: Palette;
  label: string;
  field: PassphraseField;
  /** Columns inside the panel. The field and its counter share them. */
  width: number;
  active: boolean;
}) {
  const counter = `${field.value.length} of ${MAX_PASSPHRASE_LENGTH}`;
  // The mask is sized against the counter, so it can never push the row into a
  // wrap and grow the panel past its budget.
  const masked = maskedPassphrase(field, Math.max(8, width - counter.length - 6));

  return (
    <box flexDirection="column" paddingTop={space.sm} flexShrink={0}>
      <text wrapMode="none" fg={colours.textDim}>
        {label}
      </text>
      <box
        flexDirection="row"
        border
        borderStyle="single"
        borderColor={active ? colours.borderFocus : colours.border}
        paddingX={1}
        overflow="hidden"
      >
        <text wrapMode="none" fg={active ? colours.lime : colours.textMuted}>
          {masked}
        </text>
        {active ? (
          <text wrapMode="none" fg={colours.borderFocus}>
            ▌
          </text>
        ) : null}
        {/* The counter is the only thing that says a field has content: the mask
            itself is just a row of dots. */}
        <text wrapMode="none" fg={colours.textDim}>
          {field.value.length === 0 ? "" : ` ${counter}`}
        </text>
      </box>
    </box>
  );
}

/**
 * The footer's line while a passphrase is being asked for.
 *
 * The prompt owns the keyboard, so the footer has to stop advertising the keys
 * of the screen it replaced — they would do nothing. Same rule as everywhere
 * else (decision R13): whole sentences at three lengths, never a truncated one,
 * and the shortest has to fit the 20 columns a 40-wide terminal leaves.
 */
export function passphraseHint(reason: "unlock" | "create", mode: LayoutMode): string {
  const action = reason === "create" ? "save" : "unlock";
  if (mode === "compact") return "type · enter · esc";
  if (mode === "single-column") return `type a passphrase · enter ${action} · esc`;
  return `type your passphrase · enter to ${action} · esc to cancel`;
}
