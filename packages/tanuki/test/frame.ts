/**
 * Frame helpers shared by the interface tests.
 *
 * The test renderer's own `waitForFrame` gives up as soon as its scheduler is
 * idle, so it cannot see work that finishes on the real event loop (a file
 * read, say). `until` below pumps frames *and* yields to the loop, which is
 * what makes the asynchronous screens testable.
 *
 * Frames are flattened (runs of whitespace collapsed to one space) before a
 * predicate sees them, so assertions are about the words on screen rather than
 * about where a panel happened to wrap them. Write expected strings with single
 * spaces.
 */
import type { testRender } from "@opentui/react/test-utils";

type Rendered = Awaited<ReturnType<typeof testRender>>;

/** The minimum a rendered tree needs to be pumped and probed. */
export type FrameHost = Pick<Rendered, "renderOnce" | "captureCharFrame" | "mockInput" | "dispose">;

/** Renders a few frames, yielding to the event loop so real I/O can finish. */
export async function settle(app: Pick<FrameHost, "renderOnce">, passes = 8): Promise<void> {
  for (let pass = 0; pass < passes; pass++) {
    await app.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Pumps frames until the painted text satisfies `predicate`, then returns that
 * frame. Throws with the last frame rather than timing out opaquely.
 */
export async function until(
  app: FrameHost,
  predicate: (frame: string) => boolean,
  passes = 80,
): Promise<string> {
  let raw = "";
  for (let pass = 0; pass < passes; pass++) {
    await app.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 2));
    raw = app.captureCharFrame();
    const flat = flatten(raw);
    if (predicate(flat)) return flat;
  }
  throw new Error(`Frame predicate never satisfied. Last frame:\n${raw}`);
}

export function flatten(frame: string): string {
  return frame.replace(/\s+/g, " ");
}

/** Presses one key and lets the resulting render land. */
export async function press(app: FrameHost, key: string): Promise<void> {
  app.mockInput.pressKey(key);
  await settle(app, 2);
}

export async function typeText(app: FrameHost, text: string): Promise<void> {
  await app.mockInput.typeText(text);
  await settle(app, 2);
}

export async function arrow(app: FrameHost, direction: "up" | "down"): Promise<void> {
  app.mockInput.pressArrow(direction);
  await settle(app, 2);
}
