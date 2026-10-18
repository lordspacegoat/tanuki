/**
 * Credential onboarding (decision S6).
 *
 * Two screens, not a wall of text: what protects the token, then what the user
 * can change about it. Both screens read their copy from
 * `secrets/explanation.ts`, which describes the mechanism actually detected on
 * this machine — so nothing here can promise something the program does not do.
 */
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { onboardingScreens } from "../../secrets/explanation.ts";
import type { ExplanationInput } from "../../secrets/explanation.ts";
import type { CredentialMode } from "../../secrets/types.ts";
import type { Palette } from "../theme.ts";
import { space } from "../theme.ts";
import { Panel } from "../components/chrome.tsx";

export interface OnboardingProps {
  explanation: ExplanationInput;
  /** Called with the mechanism the user settled on. */
  onDone: (mode: CredentialMode) => void;
  onQuit: () => void;
  colours: Palette;
}

export function Onboarding({ explanation, onDone, onQuit, colours }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const screens = onboardingScreens(explanation);
  const screen = screens[step] ?? screens[0]!;

  // Decision S4: the keychain is preferred, with a one-keystroke opt-out.
  const preferred: CredentialMode = explanation.keychainAvailable ? "keychain" : "passphrase";

  useKeyboard((key) => {
    if (key.name === "q" && !key.ctrl) {
      onQuit();
      return;
    }
    if (key.name === "p") {
      onDone("passphrase");
      return;
    }
    if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      if (step === 0) setStep(1);
      else onDone(preferred);
      return;
    }
    if ((key.name === "b" || key.name === "left") && step === 1) setStep(0);
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={space.sm}>
      <Panel colours={colours} focused title={`Credentials · step ${step + 1} of 2`}>
        <box flexDirection="column" paddingTop={space.xs}>
          <text wrapMode="none" fg={colours.text}>
            {screen.title}
          </text>
          <text wrapMode="none" fg={colours.textDim}>
            {" "}
          </text>
          {/*
            The one place prose is allowed to wrap. These lines are the security
            explanation — clipping them to keep a row budget would hide exactly
            what the user is being asked to accept — so they wrap, and the panel
            clips the overflow instead.
          */}
          {screen.lines.map((line, index) => (
            <text key={index} fg={colours.textMuted}>
              {line.length === 0 ? " " : line}
            </text>
          ))}
        </box>

        <box flexGrow={1} />

        {/* flexShrink 0: the prose above gives up rows before the keys do. */}
        <box flexDirection="column" paddingBottom={space.xs} flexShrink={0}>
          <text wrapMode="none" fg={colours.magenta}>
            {step === 0
              ? "enter  continue"
              : explanation.keychainAvailable
                ? "enter  use the system store"
                : "enter  use a passphrase"}
          </text>
          {step === 1 && screen.action ? (
            <text wrapMode="none" fg={colours.textDim}>
              {screen.action}
            </text>
          ) : null}
          {step === 1 ? (
            <text wrapMode="none" fg={colours.textDim}>
              b  back
            </text>
          ) : null}
          <text wrapMode="none" fg={colours.textDim}>
            q  quit
          </text>
        </box>
      </Panel>
    </box>
  );
}
