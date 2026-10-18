/**
 * The footer's hint line, checked against the space it actually gets.
 *
 * This is a width test rather than a wording test. Every layout exists over a
 * known range of terminal widths, and `Footer` clips the hint to `width - 20`,
 * so a hint that is longer than its narrowest layout can hold loses its tail —
 * which is always the last key in the list, and on most screens that is `q quit`
 * or `q back`. A footer that stops just before the quit key is worse than a
 * footer with fewer keys on it, because the user concludes there is no way out.
 */
import { describe, expect, test } from "bun:test";
import { hintsFor } from "../src/tui/app.tsx";
import type { Screen } from "../src/tui/app.tsx";
import type { TanukiConfig } from "../src/config/schema.ts";
import { breakpoints } from "../src/tui/theme.ts";
import type { LayoutMode } from "../src/tui/theme.ts";
import { searchHint } from "../src/tui/components/chrome.tsx";
import { passphraseHint } from "../src/tui/screens/passphrase-prompt.tsx";

/** A configuration is only ever read for its name and id here. */
const config = { id: "c1", name: "client", credential: {}, zones: [], groups: [] } as unknown as TanukiConfig;

/** Screens that paint the shared footer. */
const screens: Screen[] = [
  { name: "idle" },
  { name: "unavailable", message: "no credential" },
  { name: "select" },
  { name: "create-missing" },
  { name: "onboarding" },
  { name: "token", replace: null, back: "select" },
  { name: "zones", config },
  { name: "groups", config },
];

/**
 * The narrowest terminal that can show each layout, and therefore the least
 * space the hint will ever get. Two-column starts at `singleColumn` columns;
 * below `compact` the app shows "too small" and there is no footer at all.
 */
const narrowest: Record<"compact" | "single-column" | "two-column", number> = {
  compact: breakpoints.compact,
  "single-column": breakpoints.singleColumn,
  "two-column": breakpoints.twoColumn,
};

function columns(line: string): number {
  return [...line].length;
}

describe("hintsFor", () => {
  const modes = ["compact", "single-column", "two-column"] as const;

  test("every hint fits the narrowest terminal of its layout", () => {
    for (const screen of screens) {
      for (const mode of modes) {
        const hint = hintsFor(screen, mode);
        const available = narrowest[mode] - 20;
        expect(columns(hint)).toBeLessThanOrEqual(available);
      }
    }
  });

  test("q is offered on every screen where q is a key at all", () => {
    // The token screen is a text field: `q` is a letter there, and saying "q
    // quit" on it would be describing a keystroke that types a character.
    const typed = new Set<Screen["name"]>(["token"]);
    for (const screen of screens) {
      if (typed.has(screen.name)) continue;
      for (const mode of modes) {
        // The groups screen goes back rather than quitting, and says so. Every
        // other screen quits. Either way the key is visible.
        expect(hintsFor(screen, mode)).toMatch(/q (quit|back)/);
      }
    }
  });

  test("the token screen says how to leave, in the panel that has the room", () => {
    // Compact cannot hold both, and `esc` is the one a first-time user needs,
    // so the footer keeps the action and the panel carries `esc cancel`.
    const token: Screen = { name: "token", replace: null, back: "select" };
    expect(hintsFor(token, "two-column")).toContain("esc cancel");
    expect(hintsFor(token, "single-column")).toContain("esc cancel");
    expect(hintsFor(token, "compact")).toContain("enter");
  });

  test("the compact form is a shorter sentence, not a truncated one", () => {
    for (const screen of screens) {
      const compact = hintsFor(screen, "compact");
      // No hint is built by cutting another one down, because a cut hint ends
      // mid-word ("r refr…") and teaches nothing.
      expect(compact).not.toContain("…");
      // And it never has more on it than the roomier form: compact is a
      // reduction, never a rewrite that grows.
      for (const mode of ["single-column", "two-column"] as const) {
        expect(columns(compact)).toBeLessThanOrEqual(columns(hintsFor(screen, mode)));
      }
    }
  });
});

describe("passphraseHint", () => {
  // The prompt takes the whole screen, so its hint replaces the screen's own.
  // It gets the same budget test: the shortest form has to fit the 20 columns a
  // 40-wide terminal leaves, or the way out is the part that gets cut.
  const modes: Array<"compact" | "single-column" | "two-column"> = [
    "compact",
    "single-column",
    "two-column",
  ];
  const reasons: Array<"unlock" | "create"> = ["unlock", "create"];

  test("fits the narrowest terminal of its layout, and always offers esc", () => {
    for (const reason of reasons) {
      for (const mode of modes) {
        const hint = passphraseHint(reason, mode);
        expect(columns(hint)).toBeLessThanOrEqual(narrowest[mode] - 20);
        expect(hint).toContain("esc");
      }
    }
  });

  test("is a shorter sentence at each step, never a truncated one", () => {
    for (const reason of reasons) {
      const compact = passphraseHint(reason, "compact");
      expect(compact).not.toContain("…");
      expect(columns(compact)).toBeLessThanOrEqual(columns(passphraseHint(reason, "single-column")));
      expect(columns(passphraseHint(reason, "single-column"))).toBeLessThanOrEqual(
        columns(passphraseHint(reason, "two-column")),
      );
    }
  });

  test("says what enter does, and it is not the same word for both reasons", () => {
    expect(passphraseHint("unlock", "two-column")).toContain("unlock");
    expect(passphraseHint("create", "two-column")).toContain("save");
  });
});

describe("searchHint", () => {  // The same rule for the line inside a panel, which is where the key that
  // clears a filter gets cut off on a narrow terminal.
  test("shortens to whole phrases, never to a cut word", () => {
    for (let available = 0; available <= 60; available += 1) {
      const hint = searchHint(available);
      expect(hint).not.toContain("…");
      expect(hint.startsWith("type to filter")).toBe(true);
    }
  });

  test("keeps the escape hatch wherever there is room for it", () => {
    expect(searchHint(45)).toContain("esc to clear");
    expect(searchHint(30)).toBe("type to filter · enter keep");
    // At 40 columns a panel has about 34: the filter is the one that has to
    // stay, because it is the thing the keyboard is doing.
    expect(searchHint(20)).toBe("type to filter");
  });
});
