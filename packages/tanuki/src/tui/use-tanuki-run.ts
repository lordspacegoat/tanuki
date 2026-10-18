/**
 * Drives the header runner: a small tanuki that crosses the tagline once in a
 * while, and every time a purge starts.
 *
 * Steps advance on a timer rather than on the renderer's frame loop, so the run
 * costs nothing when it is not happening and cannot depend on the frame rate.
 * The occasional run is on a slow interval — minutes, not seconds — because an
 * easter egg that happens constantly is not an easter egg.
 */
import { useCallback, useEffect, useState } from "react";
import { RUNNER_STEPS, RUNNER_WIDTH } from "./mascot.ts";

/** How long one column of the run takes. Fast enough to read as a scurry. */
export const RUNNER_TICK_MS = 70;
/** Never sooner than this. Nothing waits for it, so it may be late. */
export const RUNNER_OCCASIONAL_MS = 90_000;

export interface TanukiRun {
  /** How far across the track the sprite has walked. */
  step: number;
  /** True while a run is in progress. */
  running: boolean;
  /** Starts a run. Restarts one already in progress. */
  trigger: () => void;
}

export function useTanukiRun(
  tickMs: number = RUNNER_TICK_MS,
  occasionalMs: number = RUNNER_OCCASIONAL_MS,
): TanukiRun {
  const [step, setStep] = useState(0);

  // Derived rather than stored: a run is exactly the range of steps that are on
  // the track. That keeps the timer and the sprite from ever disagreeing.
  const running = step > 0 && step <= RUNNER_STEPS;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setStep((current) => current + 1), tickMs);
    return () => clearInterval(timer);
  }, [running, tickMs]);

  useEffect(() => {
    const timer = setInterval(() => setStep(RUNNER_WIDTH), occasionalMs);
    return () => clearInterval(timer);
  }, [occasionalMs]);

  // Started at the sprite's own width, so the first frame of a run shows the
  // whole tanuki rather than a sliver of one arriving from off-stage.
  const trigger = useCallback(() => setStep(RUNNER_WIDTH), []);

  return { step, running, trigger };
}
