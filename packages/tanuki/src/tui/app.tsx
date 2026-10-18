/**
 * The application shell: resolves what should be on screen, then gets out of the
 * way.
 *
 * Screen choice is deliberate and explicit. A named `--config` either resolves or
 * it does not; a failure is stated and offered as a creation, never silently
 * replaced by a different configuration (decision §4, D2).
 *
 * Credentials are read through `ConfigManager`, never here, and a credential that
 * cannot be read produces the "unavailable" state rather than deleting anything
 * (decision S5).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createCliRenderer } from "@opentui/core";
import type { TerminalCapabilities } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { CloudflareClient } from "../cloudflare/client.ts";
import { CloudflareClient as Client } from "../cloudflare/client.ts";
import { resolvePaths } from "../config/paths.ts";
import { createCredentialStores } from "../secrets/store.ts";
import type { CredentialStores } from "../secrets/store.ts";
import { PassphrasePrompter } from "../secrets/prompt.ts";
import type { PassphraseRequest } from "../secrets/prompt.ts";
import { ConfigManager } from "../config/manager.ts";
import { CredentialUnavailableError, PassphraseCancelledError } from "../secrets/types.ts";
import { explainCredentials } from "../secrets/explanation.ts";
import type { CredentialMode } from "../secrets/types.ts";
import { connect, replaceToken } from "../services/connection.ts";
import type { ConnectionResult } from "../services/connection.ts";
import { redact } from "../services/redact.ts";
import type { TanukiConfig } from "../config/schema.ts";
import { layoutMode, listRows, resolvePalette, space } from "./theme.ts";
import type { LayoutMode, Palette } from "./theme.ts";
import { clip } from "./format.ts";
import { useTanukiRun } from "./use-tanuki-run.ts";
import { Footer, Panel, TooSmall, Wordmark } from "./components/chrome.tsx";
import { Onboarding } from "./screens/onboarding.tsx";
import { TokenEntry } from "./screens/token-entry.tsx";
import { ConfigSelect } from "./screens/config-select.tsx";
import { ZoneExplorer } from "./screens/zone-explorer.tsx";
import { GroupsScreen } from "./screens/groups.tsx";
import { PassphrasePrompt, passphraseHint } from "./screens/passphrase-prompt.tsx";

export interface LaunchOptions {
  config: string | null;
}

export interface BootInfo {
  requestedConfig: string | null;
  /** Null when nothing was named, or when the name did not resolve. */
  resolvedConfig: { id: string; name: string } | null;
  missingConfig: boolean;
  configs: Array<{ id: string; name: string }>;
  activeConfigId: string | null;
  credentialLabel: string;
  credentialMode: CredentialMode;
  keychainAvailable: boolean;
  platform: NodeJS.Platform;
}

/** Injected so tests never construct a real client or touch the network. */
export interface AppDeps {
  manager: ConfigManager;
  stores: CredentialStores;
  clientFor: (token: string) => CloudflareClient;
  /**
   * Brokers the passphrase question between the credential store and the
   * interface (see `secrets/prompt.ts`). Always present in a real run; a test
   * with in-memory stores simply never has a question asked.
   */
  prompter: PassphrasePrompter;
}

export interface AppProps {
  info: BootInfo;
  deps: AppDeps;
}

class BootError extends Error {}

export async function launch(options: LaunchOptions): Promise<number> {
  let info: BootInfo;
  let deps: AppDeps;

  try {
    ({ info, deps } = await boot(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tanuki: ${redact(message)}\n`);
    if (error instanceof BootError) process.stderr.write("Run `tanuki --help` for usage.\n");
    return 1;
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    // Mouse stays off until there is a reason for it; a TUI that captures the
    // mouse without one is hostile to terminal scrollback.
    useMouse: false,
    targetFps: 30,
  });

  createRoot(renderer).render(<App info={info} deps={deps} />);

  // `closed` resolves once destroy() has restored the terminal. Awaiting it is
  // the whole shutdown contract: nothing else may write to stdout after this.
  await renderer.closed;
  return 0;
}

async function boot(options: LaunchOptions): Promise<{ info: BootInfo; deps: AppDeps }> {
  const paths = resolvePaths();

  // The store cannot draw and the renderer does not exist yet, so the question
  // is parked here and answered by the interface once it is on screen.
  const prompter = new PassphrasePrompter();

  const stores = await createCredentialStores({
    paths,
    prompt: prompter.request,
  });

  const manager = new ConfigManager(paths, stores);

  let manifest;
  try {
    manifest = await manager.loadManifest();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BootError(`${message} (at ${paths.manifest})`);
  }

  let resolvedConfig: { id: string; name: string } | null = null;
  let missingConfig = false;

  if (options.config !== null) {
    const entry = await manager.findByName(options.config);
    if (entry) {
      resolvedConfig = entry;
      await manager.setActive(entry.id);
    } else {
      missingConfig = true;
    }
  }

  return {
    info: {
      requestedConfig: options.config,
      resolvedConfig,
      missingConfig,
      configs: manifest.configs.map((entry) => ({ id: entry.id, name: entry.name })),
      activeConfigId: manifest.activeConfigId,
      credentialLabel: stores.keychainAvailable ? stores.keychainLabel : "none detected",
      credentialMode: stores.preferred,
      keychainAvailable: stores.keychainAvailable,
      platform: process.platform,
    },
    deps: {
      manager,
      stores,
      clientFor: (token) => new Client({ token }),
      prompter,
    },
  };
}

/** Which screen owns the keyboard. Exported so the footer's hints can be tested
 * against every screen, including the ones no test drives directly. */
export type Screen =
  | { name: "idle" }
  | { name: "unavailable"; message: string }
  | { name: "select" }
  | { name: "create-missing" }
  | { name: "onboarding" }
  | { name: "token"; replace: TanukiConfig | null; back: "select" | "zones" }
  | { name: "zones"; config: TanukiConfig }
  | { name: "groups"; config: TanukiConfig };

export function App({ info, deps }: AppProps) {
  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();

  // Capability detection is asynchronous, and a `false` early on can mean "not
  // known yet" rather than "unsupported". Start from true and correct down.
  const [rgb, setRgb] = useState<boolean>(() => renderer.capabilities?.rgb ?? true);
  const [screen, setScreen] = useState<Screen>({ name: "idle" });
  const [configs, setConfigs] = useState(info.configs);
  const [activeConfigId, setActiveConfigId] = useState(info.activeConfigId);
  const [mode, setMode] = useState<CredentialMode>(info.credentialMode);
  // A screen that has taken over the keyboard pushes `""` so the footer stops
  // advertising keys that would do something else; null restores the default.
  const [hintOverride, setHintOverride] = useState<string | null>(null);
  // The passphrase question, when one is outstanding. Held as state rather than
  // read from the prompter during render so React re-renders when it is asked.
  const [passphraseRequest, setPassphraseRequest] = useState<PassphraseRequest | null>(null);
  const run = useTanukiRun();

  useEffect(() => {
    const onCapabilities = (capabilities: TerminalCapabilities) => setRgb(capabilities.rgb);
    renderer.on("capabilities", onCapabilities);
    return () => {
      renderer.off("capabilities", onCapabilities);
    };
  }, [renderer]);

  // `subscribe` hands over the outstanding question immediately, so a request
  // asked before this mounted is not lost.
  useEffect(() => deps.prompter.subscribe(setPassphraseRequest), [deps.prompter]);

  const colours = resolvePalette({ rgb });
  const layout = layoutMode(width, height);

  const explanationInput = {
    mode,
    keychainAvailable: info.keychainAvailable,
    keychainLabel: info.keychainAvailable ? info.credentialLabel : "your system credential store",
    platform: info.platform,
  };

  const openConfig = useCallback(
    async (id: string) => {
      try {
        const config = await deps.manager.load(id);
        // Read the credential *here*, so an unreadable one lands on the dedicated
        // "credentials unavailable" screen (decision S5) rather than surfacing as
        // a one-line notice at the first purge.
        await requireCredential(deps.manager, config);
        await deps.manager.setActive(id);
        setScreen({ name: "zones", config });
      } catch (error) {
        // A dismissed passphrase prompt is a decision, not a fault: the user is
        // put back on the list rather than shown a "credentials unavailable"
        // screen they cannot act on.
        if (error instanceof PassphraseCancelledError) {
          setScreen({ name: "select" });
          return;
        }
        setScreen({ name: "unavailable", message: describeCredentialFailure(error) });
      }
    },
    [deps.manager],
  );

  // Decide the first screen once. `idle` renders nothing, so there is no flash of
  // the wrong screen before this runs.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (info.missingConfig) setScreen({ name: "create-missing" });
    else if (info.configs.length === 0) setScreen({ name: "onboarding" });
    else if (info.resolvedConfig) void openConfig(info.resolvedConfig.id);
    else setScreen({ name: "select" });
  }, [info, openConfig]);

  const quit = useCallback(() => renderer.destroy(), [renderer]);
  const goToOnboarding = useCallback(() => setScreen({ name: "onboarding" }), []);

  // Screens that handle their own keys do so in their own component. This
  // handler covers only the screens that do not, so a key is never handled twice.
  useKeyboard((key) => {
    // A passphrase prompt stands in front of the screen it interrupted, and the
    // screen underneath is unmounted while it is up. Without this, `q` in a
    // passphrase would be read by the *selector's* rule below and quit the app.
    if (passphraseRequest !== null) return;

    switch (screen.name) {
      case "idle":
      case "unavailable":
        if (key.name === "q" && !key.ctrl) quit();
        return;

      case "create-missing":
        if (key.name === "return" || key.name === "enter" || key.name === "linefeed") goToOnboarding();
        else if (key.name === "escape") setScreen({ name: "select" });
        else if (key.name === "q" && !key.ctrl) quit();
        return;

      case "select":
        if (key.name === "q" && !key.ctrl) quit();
        return;

      // onboarding, token and zones own every key they need.
      default:
        return;
    }
  });

  const refreshConfigs = useCallback(async () => {
    const list = await deps.manager.list();
    setConfigs(list.map((entry) => ({ id: entry.id, name: entry.name })));
    // The active pointer is re-read too: deleting the active configuration moves
    // it, and a stale badge would mark a row that no longer exists while the one
    // Tanuki would actually open is unmarked.
    setActiveConfigId((await deps.manager.loadManifest()).activeConfigId);
    return list;
  }, [deps.manager]);

  const handleConnected = useCallback(
    (result: ConnectionResult) => {
      if (!result.ok) return;
      setConfigs((current) => [...current, { id: result.config.id, name: result.config.name }]);
      setScreen({ name: "zones", config: result.config });
    },
    [],
  );

  /**
   * Renames a configuration. Resolves to null, or to a sentence for the
   * selector to show under the field. A name that will not do is the common
   * case, and it must not look like a rejected keystroke.
   */
  const renameConfig = useCallback(
    async (id: string, name: string): Promise<string | null> => {
      try {
        const renamed = await deps.manager.rename(id, name);
        setConfigs((current) =>
          current.map((entry) => (entry.id === id ? { id, name: renamed.name } : entry)),
        );
        return null;
      } catch (error) {
        return redact(error instanceof Error ? error.message : String(error));
      }
    },
    [deps.manager],
  );

  const persistZones = useCallback(
    async (config: TanukiConfig, zones: TanukiConfig["zones"]) => {
      const saved = await deps.manager.save({ ...config, zones });
      setScreen({ name: "zones", config: saved });
    },
    [deps.manager],
  );

  const persistGroups = useCallback(
    async (config: TanukiConfig, groups: TanukiConfig["groups"]) => {
      const saved = await deps.manager.save({ ...config, groups });
      setScreen({ name: "groups", config: saved });
    },
    [deps.manager],
  );

  /**
   * Deletes a configuration: its file, its token and its zone list.
   *
   * The one irreversible action in the interface, so it is not offered anywhere
   * else and never happens without an answered `y`. Deleting the last
   * configuration lands on onboarding rather than on an empty selector: an empty
   * list with no way forward is a dead end, and this is the same screen a first
   * run gets.
   */
  const deleteConfig = useCallback(
    async (id: string): Promise<string | null> => {
      try {
        await deps.manager.remove(id);
      } catch (error) {
        return redact(error instanceof Error ? error.message : String(error));
      }

      const remaining = await refreshConfigs();
      if (remaining.length === 0) setScreen({ name: "onboarding" });
      return null;
    },
    [deps.manager, refreshConfigs],
  );

  const hint = useCallback((value: string | null) => setHintOverride(value), []);
  const startRun = useCallback(() => run.trigger(), [run]);

  /**
   * Where the user lands after a dismissed passphrase prompt.
   *
   * The prompt took the token form's place, and the paste went with it, so
   * "cancelled" has to lead somewhere real rather than back to an emptied form
   * with no explanation: the list, or onboarding when that was going to be the
   * first configuration. This runs *after* the operation has settled, because
   * the rollback is what removes the half-created configuration — reading the
   * list any earlier would show the row that is about to disappear.
   *
   * The pasted token is deliberately not kept in order to refill the form. This
   * tool does not hold a live token past the operation that needed it.
   */
  const afterInterruption = useCallback(
    async (result: ConnectionResult) => {
      if (result.ok || result.reason !== "interrupted") return;
      const remaining = await refreshConfigs();
      setScreen(remaining.length === 0 ? { name: "onboarding" } : { name: "select" });
    },
    [refreshConfigs],
  );

  if (layout === "too-small") {
    return <TooSmall width={width} height={height} colours={colours} />;
  }

  // One key handler for quitting from any screen that does not own `q` itself.
  const listHeight = listRows(height, layout, "list");
  const groupsHeight = listRows(height, layout, "panel");
  const editorHeight = listRows(height, layout, "editor");
  const newConfigName = info.requestedConfig ?? nextConfigName(configs);

  // The vault is addressed by the configuration's ID, so the name it is shown
  // under is looked up here rather than carried through the credential store.
  const unlockName =
    passphraseRequest === null
      ? null
      : (configs.find((entry) => entry.id === passphraseRequest.context.id)?.name ?? null);

  return (
    <box flexDirection="column" backgroundColor={colours.base} flexGrow={1} paddingX={1}>
      <Wordmark colours={colours} rgb={rgb} mode={layout} run={run} />

      {/* A passphrase prompt takes the screen rather than floating over it. The
          library delivers each keypress to every registered handler, so an
          overlay would let `/` start a search on the list beneath while the
          user was typing a passphrase. */}
      {passphraseRequest === null ? (
        renderScreen()
      ) : (
        <PassphrasePrompt
          // A fresh field per question: a retry after a failed attempt should not
          // leave the rejected passphrase sitting in the box.
          key={passphraseRequest.sequence}
          reason={passphraseRequest.context.reason}
          subject={unlockName}
          error={passphraseRequest.context.error ?? null}
          onSubmit={(value) => passphraseRequest.answer(value)}
          onCancel={() => passphraseRequest.dismiss()}
          colours={colours}
        />
      )}

      {/* The prompt owns the keyboard, so the footer describes the prompt.
          Leaving the screen's keys there would advertise keys that do nothing. */}
      <Footer
        colours={colours}
        mode={layout}
        hints={
          passphraseRequest === null
            ? (hintOverride ?? hintsFor(screen, layout))
            : passphraseHint(passphraseRequest.context.reason, layout)
        }
      />
    </box>
  );

  function renderScreen() {
    switch (screen.name) {
      case "idle":
        return <box flexGrow={1} />;

      case "unavailable":
        return (
          <box flexDirection="column" flexGrow={1} paddingTop={space.sm}>
            <Panel colours={colours} focused title="Credentials unavailable">
              <box flexDirection="column" paddingTop={space.xs}>
                <text wrapMode="none" fg={colours.red}>
                  {clip(screen.message, width - 6)}
                </text>
                <text wrapMode="none" fg={colours.textMuted}>
                  {clip(
                    "Tanuki has not changed or deleted anything. Nothing is removed automatically.",
                    width - 6,
                  )}
                </text>
              </box>
              <box flexGrow={1} />
              <box flexDirection="column" paddingBottom={space.xs} flexShrink={0}>
                <text wrapMode="none" fg={colours.textDim}>
                  q  quit
                </text>
              </box>
            </Panel>
          </box>
        );

      case "create-missing":
        return (
          <box flexDirection="column" flexGrow={1} paddingTop={space.sm}>
            <Panel colours={colours} focused title="Create configuration">
              <box flexDirection="column" paddingTop={space.xs}>
                <text wrapMode="none" fg={colours.amber}>
                  No configuration called <span fg={colours.magenta}>{info.requestedConfig}</span> exists.
                </text>
                <text wrapMode="none" fg={colours.textMuted}>
                  Tanuki will not fall back to a different configuration.
                </text>
              </box>
              <box flexGrow={1} />
              <box flexDirection="column" paddingBottom={space.xs} flexShrink={0}>
                <text wrapMode="none" fg={colours.magenta}>
                  enter  create it
                </text>
                <text wrapMode="none" fg={colours.textDim}>
                  esc  open the configuration list
                </text>
              </box>
            </Panel>
          </box>
        );

      case "select":
        return (
          <ConfigSelect
            configs={configs}
            activeConfigId={activeConfigId}
            onOpen={(id) => void openConfig(id)}
            onCreate={() => setScreen({ name: "onboarding" })}
            onRename={renameConfig}
            onDelete={deleteConfig}
            onReplaceToken={(id) => {
              const entry = configs.find((candidate) => candidate.id === id);
              if (!entry) return;
              void deps.manager
                .load(id)
                .then((config) => setScreen({ name: "token", replace: config, back: "select" }))
                .catch((error: unknown) =>
                  setScreen({ name: "unavailable", message: describeCredentialFailure(error) }),
                );
            }}
            colours={colours}
            height={groupsHeight}
          />
        );

      case "onboarding":
        return (
          <Onboarding
            explanation={explanationInput}
            colours={colours}
            onDone={(chosen) => {
              setMode(chosen);
              setScreen({ name: "token", replace: null, back: "select" });
            }}
            onQuit={quit}
          />
        );

      case "token": {
        const replacing = screen.replace;
        return (
          <TokenEntry
            configName={replacing?.name ?? newConfigName}
            mode={replacing ? "replace" : "create"}
            explanation={explainCredentials({ ...explanationInput, mode })}
            colours={colours}
            onCancel={() => {
              if (replacing && screen.back === "zones") {
                setScreen({ name: "zones", config: replacing });
                return;
              }
              void refreshConfigs().then(() => setScreen({ name: "select" }));
            }}
            onSubmit={async (token) => {
              if (replacing) {
                const result = await replaceToken(deps.manager, {
                  configId: replacing.id,
                  token,
                  client: deps.clientFor(token),
                });
                if (result.ok) setScreen({ name: "zones", config: result.config });
                // A failure is reported on the screen; the token is unchanged.
                else await afterInterruption(result);
                return result.ok ? { ok: true as const } : result;
              }

              const result = await connect(deps.manager, {
                name: newConfigName,
                token,
                mode,
                client: deps.clientFor(token),
              });
              // A success has to move the screen, or the token screen would sit
              // on "checking" forever with a working configuration behind it.
              if (result.ok) handleConnected(result);
              else await afterInterruption(result);
              return result;
            }}
          />
        );
      }

      case "zones":
        return (
          <ZoneExplorer
            key={screen.config.id}
            config={screen.config}
            colours={colours}
            mode={layout}
            height={listHeight}
            getClient={async () => deps.clientFor(await requireCredential(deps.manager, screen.config))}
            onQuit={quit}
            onZonesChanged={(zones) => persistZones(screen.config, zones)}
            onOpenGroups={() => setScreen({ name: "groups", config: screen.config })}
            onReplaceToken={() => setScreen({ name: "token", replace: screen.config, back: "zones" })}
            onPurgeStart={startRun}
            onHint={hint}
          />
        );

      case "groups":
        return (
          <GroupsScreen
            key={screen.config.id}
            config={screen.config}
            colours={colours}
            mode={layout}
            height={groupsHeight}
            editorHeight={editorHeight}
            getClient={async () => deps.clientFor(await requireCredential(deps.manager, screen.config))}
            onGroupsChanged={(groups) => persistGroups(screen.config, groups)}
            onBack={() => setScreen({ name: "zones", config: screen.config })}
            onPurgeStart={startRun}
            onHint={hint}
          />
        );
    }
  }
}

/**
 * Reads the configuration's token, or explains why it cannot be used.
 *
 * A missing credential and a dismissed passphrase prompt are different answers:
 * the first is a state the user has to fix, the second is a decision already
 * made. Only the first becomes the "credentials unavailable" screen.
 */
async function requireCredential(manager: ConfigManager, config: TanukiConfig): Promise<string> {
  const secret = await manager.getCredential(config.id);
  if (secret === null) {
    throw new CredentialUnavailableError(
      `No token is stored for "${config.name}". Re-enter it to use this configuration.`,
      config.id,
    );
  }
  return secret;
}

function describeCredentialFailure(error: unknown): string {
  if (error instanceof CredentialUnavailableError) return redact(error.message);
  return redact(error instanceof Error ? error.message : String(error));
}

function nextConfigName(existing: ReadonlyArray<{ name: string }>): string {
  if (!existing.some((config) => config.name === "default")) return "default";
  for (let index = 2; index < 100; index++) {
    const candidate = `default ${index}`;
    if (!existing.some((config) => config.name === candidate)) return candidate;
  }
  return `default ${Date.now()}`;
}

/**
 * The footer's hint line.
 *
 * Three rules, all about not lying:
 *
 *  - `q` is only advertised where it really quits. The zone explorer owns `q`,
 *    and the groups screen uses it to go back; a footer that says "q quit" on
 *    either of those would be describing a key that does something else.
 *  - the footer carries the *global* keys and the in-panel line carries the
 *    contextual ones, so neither has to be clipped into nonsense.
 *  - the compact form is a shorter sentence, not a truncated one. A hint that
 *    says "r refr…" teaches nothing.
 *
 * Widths are counted rather than guessed. `Footer` gives the hint `width - 20`
 * columns, and each layout only exists over a known range of widths, so every
 * line below is short enough for the narrowest terminal that can show it:
 * compact is 40–59 columns (20–39 available), single-column 60–99 (40–79), and
 * two-column 100 and up (80 and up). That is why the compact forms are terse:
 * at exactly 40 columns there is room for `↑↓ move · q quit` and not one
 * character more.
 */
export function hintsFor(screen: Screen, mode: LayoutMode): string {
  const wide = mode === "two-column";
  const compact = mode === "compact";

  switch (screen.name) {
    case "select":
      if (compact) return "enter open · q quit";
      return wide
        ? "↑↓ move · enter open · n new · r rename · t replace token · d delete · q quit"
        : "↑↓ move · enter open · n new · q quit";
    case "onboarding":
      return compact ? "enter · q quit" : "enter continue · p passphrase · q quit";
    case "token":
      return compact ? "paste · enter" : "paste · enter check · esc cancel";
    case "zones":
      if (compact) return "↑↓ move · q quit";
      return wide
        ? "↑↓ move · / search · r refresh · g groups · q quit"
        : "↑↓ move · / search · g groups · q quit";
    case "groups":
      if (compact) return "enter edit · q back";
      return wide
        ? "↑↓ move · enter edit · n new · p purge · r rename · d delete · q back"
        : "enter edit · n new · p purge · q back";
    case "create-missing":
      // "enter" is the whole action and the screen says so in full; the footer
      // only has to fit.
      return compact ? "enter · q quit" : "enter create · esc list · q quit";
    default:
      return "q quit";
  }
}
