/**
 * The multi-zone purge, from question to result.
 *
 * Decision U4 splits purging in two: a single zone is confirmed inline in the
 * list, but a group or a whole configuration goes through a screen that names
 * the counted scope first — how many zones, how many accounts, which plan sets
 * the pace, and whether the burst covers it.
 *
 * Decision U5 adds cancellation *during* the run, and says plainly that what
 * was already sent cannot be recalled. Decision U6 adds retrying only what
 * failed. Every success is reported as **accepted**, never "purged": Cloudflare
 * acknowledging a request is not the same as the cache being gone.
 *
 * The confirm question is deliberately not `enter`-to-accept. A cache purge is
 * not undoable, so it takes a letter, exactly like the inline prompt.
 */
import { useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { userMessage } from "../../cloudflare/errors.ts";
import type { PurgeProgress, PurgeSummary } from "../../services/purge-service.ts";
import { failedZoneIds, retryableZones } from "../../services/purge-service.ts";
import { scopeLines } from "../../services/purge-scope.ts";
import type { ResolvedScope } from "../../services/purge-scope.ts";
import type { ZoneRecord } from "../../config/schema.ts";
import { clip, formatMs } from "../format.ts";
import type { Palette } from "../theme.ts";
import { progressStops, space } from "../theme.ts";
import { Panel } from "../components/chrome.tsx";

/** Injected so tests never touch the network and the pacing stays real. */
export type PurgeRunFn = (
  zones: readonly ZoneRecord[],
  signal: AbortSignal,
  onProgress: (progress: PurgeProgress) => void,
) => Promise<PurgeSummary>;

export interface PurgeFlowProps {
  resolved: ResolvedScope;
  run: PurgeRunFn;
  colours: Palette;
  /** Called when the flow closes, with the result if a run actually happened. */
  onDone: (summary: PurgeSummary | null) => void;
}

/** Confirm stage, then run stage. Keeping the stage here means the explorer
 * only has to know "a purge is open", not how far along it is. */
export function PurgeFlow({ resolved, run, colours, onDone }: PurgeFlowProps) {
  const [stage, setStage] = useState<"confirm" | "run">("confirm");

  if (stage === "confirm") {
    return (
      <PurgeConfirm
        resolved={resolved}
        colours={colours}
        onConfirm={() => setStage("run")}
        onCancel={() => onDone(null)}
      />
    );
  }

  return <PurgeRun resolved={resolved} run={run} colours={colours} onDone={onDone} />;
}

export interface PurgeConfirmProps {
  resolved: ResolvedScope;
  colours: Palette;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PurgeConfirm({ resolved, colours, onConfirm, onCancel }: PurgeConfirmProps) {
  useKeyboard((key) => {
    if (key.name === "y") onConfirm();
    else if (key.name === "n" || key.name === "escape" || key.name === "q") onCancel();
  });

  const { width } = useTerminalDimensions();
  const preview = previewNames(resolved.zones);
  const zoneWord = resolved.zones.length === 1 ? "zone" : "zones";
  // The panel is the whole content area minus its own padding and border.
  const inner = Math.max(16, width - 6);

  return (
    <Panel colours={colours} focused title="Purge cache — confirm">
      <box flexDirection="column" paddingTop={space.xs}>
        <text wrapMode="none" fg={colours.text}>
          Cloudflare will clear the cached copies for:
        </text>
        <text wrapMode="none" fg={colours.magenta}>
          {clip(resolved.label, inner)}
        </text>
        {preview ? (
          <text wrapMode="none" fg={colours.textMuted}>
            {clip(preview, inner)}
          </text>
        ) : null}
      </box>

      <box flexDirection="column" paddingTop={space.sm}>
        {scopeLines(resolved).map((line, index) => (
          <text key={index} wrapMode="none" fg={colours.textMuted}>
            {clip(line, inner)}
          </text>
        ))}
      </box>

      <box flexGrow={1} />

      <box flexDirection="column" paddingBottom={space.xs}>
        <text wrapMode="none" fg={colours.magenta}>{`y  purge ${resolved.zones.length} ${zoneWord}`}</text>
        <text wrapMode="none" fg={colours.textDim}>
          n  cancel
        </text>
      </box>
    </Panel>
  );
}

export interface PurgeRunProps {
  resolved: ResolvedScope;
  run: PurgeRunFn;
  colours: Palette;
  onDone: (summary: PurgeSummary | null) => void;
}

export function PurgeRun({ resolved, run, colours, onDone }: PurgeRunProps) {
  const { width } = useTerminalDimensions();
  // The flow panel takes the whole content area; this is its inner width.
  const inner = Math.max(16, width - 6);
  const [targets, setTargets] = useState<readonly ZoneRecord[]>(resolved.zones);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"running" | "result">("running");
  const [progress, setProgress] = useState<PurgeProgress>(() => emptyProgress(resolved.zones.length));
  const [summary, setSummary] = useState<PurgeSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const controller = useRef<AbortController | null>(null);
  // The effect below reads the current props through refs rather than listing
  // them as dependencies. A purge is started by mounting and by "retry", never
  // by a parent re-render, and `run`'s identity is not guaranteed to be stable.
  const runRef = useRef(run);
  runRef.current = run;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    const ac = new AbortController();
    controller.current = ac;
    let active = true;

    setPhase("running");
    setProgress(emptyProgress(targetsRef.current.length));
    setSummary(null);
    setFailure(null);
    setConfirmCancel(false);

    void runRef
      .current(targetsRef.current, ac.signal, (next) => {
        if (active) setProgress(next);
      })
      .then((result) => {
        if (!active) return;
        setSummary(result);
        setPhase("result");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFailure(userMessage(error, "purge"));
        setPhase("result");
      });

    return () => {
      active = false;
      ac.abort();
    };
  }, [attempt]);

  const retryable = summary ? retryableZones(summary, resolved.zones) : [];

  useKeyboard((key) => {
    if (phase === "running") {
      if (confirmCancel) {
        if (key.name === "y") {
          controller.current?.abort();
          setConfirmCancel(false);
        } else if (key.name === "n" || key.name === "escape") {
          setConfirmCancel(false);
        }
        return;
      }
      if (key.name === "q" || key.name === "escape") setConfirmCancel(true);
      return;
    }

    if (key.name === "r" && retryable.length > 0) {
      setTargets(retryable);
      setAttempt((current) => current + 1);
      return;
    }
    if (
      key.name === "return" ||
      key.name === "enter" ||
      key.name === "linefeed" ||
      key.name === "q" ||
      key.name === "escape"
    ) {
      onDone(summary);
    }
  });

  if (phase === "result") {
    return (
      <Panel colours={colours} focused title="Purge cache — result">
        <box flexDirection="column" paddingTop={space.xs}>
          {failure !== null ? (
            <text wrapMode="none" fg={colours.red}>
              {clip(failure, inner)}
            </text>
          ) : summary ? (
            <ResultBody summary={summary} colours={colours} width={inner} />
          ) : null}
        </box>

        <box flexGrow={1} />

        <box flexDirection="column" paddingBottom={space.xs}>
          {retryable.length > 0 ? (
            <text wrapMode="none" fg={colours.magenta}>
              {`r  retry ${retryable.length} failed ${retryable.length === 1 ? "zone" : "zones"}`}
            </text>
          ) : null}
          <text wrapMode="none" fg={colours.textDim}>
            enter  done
          </text>
        </box>
      </Panel>
    );
  }

  const barWidth = Math.max(8, Math.min(48, width - 10));

  return (
    <Panel colours={colours} focused title="Purge cache — running">
      <box flexDirection="column" paddingTop={space.xs}>
        <text wrapMode="none" fg={colours.text}>
          {clip(`Purging the cache for ${resolved.label}`, inner)}
        </text>
      </box>

      <box flexDirection="column" paddingTop={space.sm}>
        <ProgressBar progress={progress} colours={colours} width={barWidth} />
        <text wrapMode="none" fg={colours.textMuted}>
          {`${progress.completed} of ${progress.total} zones · ${progress.accepted} accepted`}
        </text>
        {progress.failed > 0 ? (
          <text wrapMode="none" fg={colours.red}>{`${progress.failed} failed so far`}</text>
        ) : null}
      </box>

      <box flexGrow={1} />

      <box flexDirection="column" paddingBottom={space.xs}>
        {confirmCancel ? (
          <>
            <text wrapMode="none" fg={colours.amber}>
              Stop sending new purge requests?
            </text>
            <text wrapMode="none" fg={colours.textDim}>
              y  stop   ·   n  keep going
            </text>
          </>
        ) : (
          <>
            <text wrapMode="none" fg={colours.textDim}>
              requests already sent cannot be recalled
            </text>
            <text wrapMode="none" fg={colours.amber}>
              q  stop after the current requests
            </text>
          </>
        )}
      </box>
    </Panel>
  );
}

function ProgressBar({
  progress,
  colours,
  width,
}: {
  progress: PurgeProgress;
  colours: Palette;
  width: number;
}) {
  const stops = progressStops(colours, width);
  const ratio = progress.total === 0 ? 1 : progress.completed / progress.total;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));

  return (
    <text>
      {Array.from({ length: width }, (_, index) => (
        <span key={index} fg={index < filled ? (stops[index] ?? colours.violet) : colours.border}>
          {index < filled ? "█" : "░"}
        </span>
      ))}
    </text>
  );
}

function ResultBody({
  summary,
  colours,
  width,
}: {
  summary: PurgeSummary;
  colours: Palette;
  width: number;
}) {
  const failed = summary.outcomes.filter((outcome) => outcome.status === "failed");
  const skipped = summary.outcomes.filter((outcome) => outcome.status === "skipped");
  const accepted = summary.outcomes.filter((outcome) => outcome.status === "accepted");
  const zoneWord = summary.total === 1 ? "zone" : "zones";

  // Names are padded into a column so a column of purge ids can be read down.
  const nameWidth = Math.min(28, Math.max(12, ...accepted.map((outcome) => outcome.name.length)));

  return (
    <box flexDirection="column">
      <text wrapMode="none" fg={summary.failed === 0 ? colours.lime : colours.amber}>
        {`Cloudflare accepted ${summary.accepted} of ${summary.total} ${zoneWord}.`}
      </text>

      {summary.cancelled ? (
        <text wrapMode="none" fg={colours.amber}>
          {clip("Stopped early. Requests already accepted cannot be recalled.", width)}
        </text>
      ) : null}

      {/*
        Cloudflare's own reply, not a claim about it. The acknowledgement id is
        the evidence that the request landed on an account rather than on the
        floor: an id nobody invented came back from the API.
      */}
      {accepted.length > 0 ? (
        <box flexDirection="column" paddingTop={space.xs}>
          {accepted.slice(0, 5).map((outcome) => (
            <text key={outcome.zoneId} wrapMode="none" fg={colours.textMuted}>
              {clip(
                `  ${outcome.name.padEnd(nameWidth)}  Cloudflare replied ${
                  outcome.httpStatus ?? "?"
                } — purge id ${outcome.acceptedId ?? "not returned"}${
                  outcome.durationMs === undefined ? "" : ` · ${formatMs(outcome.durationMs)}`
                }`,
                width,
              )}
            </text>
          ))}
          {accepted.length > 5 ? (
            <text wrapMode="none" fg={colours.textDim}>
              {`  and ${accepted.length - 5} more`}
            </text>
          ) : null}
          <text wrapMode="none" fg={colours.textDim}>
            {`Total round trip ${formatMs(summary.durationMs)}.`}
          </text>
        </box>
      ) : null}

      {summary.outcomes.some((outcome) => (outcome.messages?.length ?? 0) > 0) ? (
        <box flexDirection="column" paddingTop={space.xs}>
          {summary.outcomes
            .filter((outcome) => (outcome.messages?.length ?? 0) > 0)
            .slice(0, 3)
            .map((outcome) => (
              <text key={outcome.zoneId} wrapMode="none" fg={colours.amber}>
                {clip(`  ${outcome.name}: ${outcome.messages!.join(" ")}`, width)}
              </text>
            ))}
        </box>
      ) : null}

      {failed.length > 0 ? (
        <box flexDirection="column" paddingTop={space.xs}>
          <text wrapMode="none" fg={colours.red}>{`${failed.length} could not be purged:`}</text>
          {failed.slice(0, 5).map((outcome) => (
            <text key={outcome.zoneId} wrapMode="none" fg={colours.textMuted}>
              {clip(`  ${outcome.name} — ${outcome.reason ?? "unknown error"}`, width)}
            </text>
          ))}
        </box>
      ) : null}

      {skipped.length > 0 ? (
        <box flexDirection="column" paddingTop={space.xs}>
          <text wrapMode="none" fg={colours.textDim}>{`${skipped.length} skipped:`}</text>
          {skipped.slice(0, 5).map((outcome) => (
            <text key={outcome.zoneId} wrapMode="none" fg={colours.textDim}>
              {clip(`  ${outcome.name} — ${outcome.reason ?? "not attempted"}`, width)}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  );
}

/** The bar has something to show before the first request finishes. */
function emptyProgress(total: number): PurgeProgress {
  return { total, completed: 0, accepted: 0, failed: 0, skipped: 0, outcomes: [] };
}

function previewNames(zones: readonly ZoneRecord[], limit = 4): string | null {
  if (zones.length <= 1) return null;
  const names = zones.slice(0, limit).map((zone) => zone.name);
  const extra = zones.length - names.length;
  return extra > 0 ? `${names.join(", ")}, +${extra} more` : names.join(", ");
}
