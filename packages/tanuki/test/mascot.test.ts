import { describe, expect, test } from "bun:test";
import {
  MASCOT,
  MASCOT_WIDTH,
  RUNNER_FRAMES,
  RUNNER_STEPS,
  mascotRows,
  runnerAt,
  runnerFrame,
} from "../src/tui/mascot.ts";

describe("the face", () => {
  test("every line is the same width, so the header cannot lean", () => {
    for (const line of MASCOT) {
      expect([...line]).toHaveLength(MASCOT_WIDTH);
    }
  });

  test("the eyes and the snout are there", () => {
    const art = MASCOT.join("\n");
    expect(art).toContain("•");
    expect(art).toContain("ᴥ");
  });

  test("only glyphs that are one cell wide in any terminal", () => {
    // A double-width glyph would shift every column after it. This is a
    // deliberately short allow-list rather than a clever check.
    const allowed = new Set([" ", "▄", "▀", "▐", "█", "▌", "•", "ᴥ"]);
    for (const character of MASCOT.join("")) {
      expect(allowed.has(character)).toBe(true);
    }
  });

  test("it costs five rows when shown, none when hidden", () => {
    expect(mascotRows(true)).toBe(MASCOT.length);
    expect(mascotRows(false)).toBe(0);
  });
});

describe("the runner", () => {
  const base = "Cloudflare cache manager";
  const sprite = RUNNER_FRAMES[0];

  test("both frames are the same width, so alternating does not jitter", () => {
    for (const frame of RUNNER_FRAMES) expect([...frame]).toHaveLength([...RUNNER_FRAMES[0]].length);
  });

  test("the frames alternate", () => {
    expect(runnerFrame(0)).not.toBe(runnerFrame(1));
    expect(runnerFrame(0)).toBe(runnerFrame(2));
  });

  test("at step 0 the sprite is off the left edge, and the base is untouched", () => {
    const frame = runnerAt(0, base, sprite);
    expect(frame.sprite).toBeNull();
    expect(frame.before).toBe(base);
    expect(frame.after).toBe("");
    expect(frame.done).toBe(false);
  });

  test("once on the track, the row keeps exactly the base's width", () => {
    for (let step = 0; step <= base.length + sprite.length; step += 1) {
      const frame = runnerAt(step, base, sprite);
      const row = frame.before + (frame.sprite ?? "") + frame.after;
      expect([...row]).toHaveLength([...base].length);
    }
  });

  test("the sprite appears whole, then slides off the right", () => {
    const entered = runnerAt([...sprite].length, base, sprite);
    expect(entered.sprite).toBe(sprite);
    expect(entered.before).toBe("");

    const leaving = runnerAt(base.length + 2, base, sprite);
    expect(leaving.sprite).toBe([...sprite].slice(0, 3).join(""));
    expect(leaving.after).toBe("");
    expect(leaving.done).toBe(false);
  });

  test("past the far end the row is the base again, and the run is over", () => {
    const frame = runnerAt(base.length + [...sprite].length, base, sprite);
    expect(frame.done).toBe(true);
    expect(frame.sprite).toBeNull();
    expect(frame.before).toBe(base);
  });

  test("one run is long enough to cross the header and leave it", () => {
    // The header pads the tagline by the sprite's width, so the track is longer
    // than the words. The run has to outlast that, or it freezes mid-crossing
    // and the sprite is still on screen when the next one starts.
    const track = base.padEnd(base.length + [...sprite].length);
    expect(runnerAt(RUNNER_STEPS, track, sprite).done).toBe(true);
  });
});
