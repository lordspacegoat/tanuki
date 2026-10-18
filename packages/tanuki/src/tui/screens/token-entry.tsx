/**
 * Token entry (decision S9).
 *
 * Paste-first, masked, with a length counter. The token is submitted to
 * `onSubmit`, which is the connect service: it verifies against Cloudflare
 * before anything is written to disk, so a failure here leaves no trace.
 *
 * The field is hand-rolled rather than OpenTUI's `Input` because `Input` paints
 * its own value — for a secret that means the token lands on screen and stays in
 * the scrollback. This screen paints the *length* and nothing else.
 */
import { useCallback, useRef, useState } from "react";
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import {
  actionForKey,
  canSubmit,
  emptyField,
  lengthLabel,
  maskedDisplay,
  reduce,
  TOKEN_MAX_LENGTH,
} from "../masked-field.ts";
import type { MaskedField } from "../masked-field.ts";
import { userMessage } from "../../cloudflare/errors.ts";
import type { MechanismExplanation } from "../../secrets/explanation.ts";
import type { Palette } from "../theme.ts";
import { space } from "../theme.ts";
import { Panel } from "../components/chrome.tsx";

export interface TokenEntryProps {
  configName: string;
  /** `replace` keeps the configuration and swaps its token (decision D9). */
  mode?: "create" | "replace";
  explanation: MechanismExplanation;
  /** Performs the verification. Injected so tests never touch the network. */
  onSubmit: (token: string) => Promise<TokenSubmitResult>;
  onCancel: () => void;
  colours: Palette;
}

/**
 * What the screen needs to know, and no more: whether to hand the screen over,
 * or what to say while keeping the field. `ConnectionResult` satisfies this, so
 * the connect path passes its own value through unchanged.
 */
export type TokenSubmitResult = { ok: true } | { ok: false; message: string };

type Phase = "editing" | "checking";

export function TokenEntry({
  configName,
  mode = "create",
  explanation,
  onSubmit,
  onCancel,
  colours,
}: TokenEntryProps) {
  const { width } = useTerminalDimensions();
  const [field, setField] = useState<MaskedField>(emptyField);
  const [phase, setPhase] = useState<Phase>("editing");
  const [message, setMessage] = useState<string | null>(null);
  const replacing = mode === "replace";

  // A ref, not state: it must be accurate synchronously, because two submits can
  // be dispatched before React re-renders.
  const inFlight = useRef(false);

  const submit = useCallback(async () => {
    if (inFlight.current || !canSubmit(field)) return;

    inFlight.current = true;
    setPhase("checking");
    setMessage(null);

    let result: TokenSubmitResult;
    try {
      result = await onSubmit(field.value);
    } catch (error) {
      // Nothing gets stuck on "checking" because the verification threw: the
      // failure is shown and the field is handed back, untouched.
      setMessage(userMessage(error, "verify"));
      setPhase("editing");
      inFlight.current = false;
      return;
    }

    if (result.ok) return; // The parent replaces this screen.

    // Keep the field as it was: a mistyped token is easier to correct than to
    // re-paste, and it was never written anywhere.
    setMessage(result.message);
    setPhase("editing");
    inFlight.current = false;
  }, [field, onSubmit]);

  useKeyboard((key) => {
    if (phase === "checking") return;
    if (key.name === "escape") {
      onCancel();
      return;
    }

    const action = actionForKey(key);
    if (action.type === "submit") {
      void submit();
      return;
    }
    if (action.type === "ignore") return;
    setField((current) => reduce(current, action));
  });

  usePaste((event) => {
    if (phase !== "editing") return;
    // PasteEvent carries bytes, not text; decoding is the documented path.
    const text = decodePasteBytes(event.bytes);
    setField((current) => reduce(current, { type: "insert", text }));
  });

  const ready = canSubmit(field);
  // The mask is sized to the panel rather than a fixed 48, so it cannot wrap and
  // push the layout around on a narrow terminal.
  const masked = maskedDisplay(field, Math.max(8, width - 12));

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={space.sm}>
      <Panel
        colours={colours}
        focused
        title={`${replacing ? "Replace token" : "New configuration"} · ${configName}`}
      >
        <box flexDirection="column" paddingTop={space.xs}>
          <text wrapMode="none" fg={colours.textMuted}>
            {replacing
              ? `Paste the replacement token for ${configName}.`
              : "Paste a Cloudflare API token."}
          </text>
          <text wrapMode="none" fg={colours.textDim}>
            {replacing
              ? "The current token keeps working until Cloudflare confirms the new one."
              : `Paste with ${process.platform === "darwin" ? "⌘V" : "Ctrl+Shift+V"}. Nothing is written to disk until Cloudflare confirms the token.`}
          </text>
        </box>

        <box flexDirection="column" paddingTop={space.sm}>
          <text wrapMode="none" fg={colours.textDim}>
            API token
          </text>
          <box flexDirection="row" border borderStyle="single" borderColor={colours.border} paddingX={1}>
            <text wrapMode="none" fg={phase === "editing" ? colours.lime : colours.textMuted}>
              {masked}
            </text>
            {phase === "editing" ? (
              <text wrapMode="none" fg={colours.borderFocus}>
                ▌
              </text>
            ) : null}
          </box>
          <text wrapMode="none" fg={colours.textMuted}>
            {lengthLabel(field)}
          </text>
        </box>

        <box flexDirection="column" paddingTop={space.sm}>
          <text wrapMode="none" fg={colours.textDim}>
            {explanation.title}
          </text>
        </box>

        <box flexGrow={1} />

        {phase === "checking" ? (
          <text wrapMode="none" fg={colours.cyan}>
            Checking with Cloudflare…
          </text>
        ) : message !== null ? (
          <text wrapMode="none" fg={colours.red}>
            {message}
          </text>
        ) : ready ? (
          <text wrapMode="none" fg={colours.magenta}>
            {replacing ? "enter  check and replace" : "enter  check and save"}
          </text>
        ) : (
          // A blank line, not a second hint: the hint below already carries
          // "esc cancel", and a layout that jumps when the field fills is worse.
          <text wrapMode="none"> </text>
        )}

        <box flexDirection="column" paddingBottom={space.xs}>
          <text wrapMode="none" fg={colours.textDim}>
            {`up to ${TOKEN_MAX_LENGTH} characters · esc  cancel`}
          </text>
        </box>
      </Panel>
    </box>
  );
}
