import { describe, expect, test } from "bun:test";
import { clip, fitHint, formatMs, relativeTime } from "../src/tui/format.ts";

describe("clip", () => {
  test("leaves text that fits alone", () => {
    expect(clip("acme.com", 12)).toBe("acme.com");
    expect(clip("acme.com", 8)).toBe("acme.com");
  });

  test("shortens with an ellipsis so the cut is visible", () => {
    expect(clip("abcdefghij", 5)).toBe("abcd…");
    expect(clip("acme-shop.com", 6)).toBe("acme-…");
  });

  test("counts code points, not UTF-16 units", () => {
    // Seven code points, so six columns is a cut. A naive `.length` would have
    // called this eleven and returned it whole.
    expect(clip("↑↓ move", 6)).toBe("↑↓ mo…");
  });

  test("degenerate widths do not throw", () => {
    expect(clip("anything", 0)).toBe("");
    expect(clip("anything", -4)).toBe("");
    expect(clip("anything", 1)).toBe("…");
    expect(clip("", 4)).toBe("");
  });
});

describe("fitHint", () => {
  const forms = ["a long sentence here", "a medium one", "short"];

  test("picks the longest form that fits", () => {
    expect(fitHint(30, forms)).toBe("a long sentence here");
    // Exactly at the boundary: twenty characters fits in twenty columns.
    expect(fitHint(20, forms)).toBe("a long sentence here");
    expect(fitHint(19, forms)).toBe("a medium one");
    expect(fitHint(5, forms)).toBe("short");
  });

  test("never hands back a half sentence", () => {
    // The whole point: whatever it returns is one of the forms, not a cut of
    // one, so a hint can never end mid-word with an ellipsis.
    for (let columns = 0; columns < 40; columns += 1) {
      expect(forms).toContain(fitHint(columns, forms));
    }
  });

  test("falls back to the shortest rather than to nothing", () => {
    expect(fitHint(0, forms)).toBe("short");
    expect(fitHint(-3, forms)).toBe("short");
  });
});

describe("formatMs", () => {
  test("keeps sub-second times in milliseconds", () => {
    expect(formatMs(0)).toBe("0 ms");
    expect(formatMs(214)).toBe("214 ms");
    expect(formatMs(999)).toBe("999 ms");
  });

  test("switches to seconds, one decimal", () => {
    expect(formatMs(1000)).toBe("1.0 s");
    expect(formatMs(1840)).toBe("1.8 s");
  });

  test("refuses to invent a duration", () => {
    expect(formatMs(Number.NaN)).toBe("an unknown time");
    expect(formatMs(-1)).toBe("an unknown time");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test("reads as a person would say it", () => {
    expect(relativeTime(ago(0), now)).toBe("just now");
    expect(relativeTime(ago(20_000), now)).toBe("just now");
    expect(relativeTime(ago(60_000), now)).toBe("1 minute ago");
    expect(relativeTime(ago(3 * 60_000), now)).toBe("3 minutes ago");
    expect(relativeTime(ago(2 * 3_600_000), now)).toBe("2 hours ago");
    expect(relativeTime(ago(30 * 3_600_000), now)).toBe("1 day ago");
    expect(relativeTime(ago(5 * 86_400_000), now)).toBe("5 days ago");
  });

  test("singular and plural are not guessed", () => {
    expect(relativeTime(ago(60_000), now)).toContain("1 minute ago");
    expect(relativeTime(ago(120_000), now)).toContain("2 minutes ago");
  });

  test("a timestamp in the future does not read as the future", () => {
    // A clock that moved, or a file written elsewhere. "in 4 minutes" would be
    // worse than useless: it implies a schedule nobody set.
    expect(relativeTime(new Date(now + 4 * 60_000).toISOString(), now)).toBe("just now");
  });

  test("past a month, a date says more than a duration", () => {
    expect(relativeTime(ago(120 * 86_400_000), now)).toBe("2026-02-01");
  });

  test("an unparseable stamp is said to be unknown", () => {
    expect(relativeTime("not a date", now)).toBe("at an unknown time");
  });
});
