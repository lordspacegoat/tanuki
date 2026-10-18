import { describe, expect, test } from "bun:test";
import { MASCOT } from "../src/tui/mascot.ts";
import {
  breakpoints,
  chromeRows,
  fallback256,
  gradientStops,
  headerRows,
  hexToRgb,
  layoutMode,
  listRows,
  palette,
  progressStops,
  rgbToHex,
  showsMascot,
} from "../src/tui/theme.ts";

describe("gradientStops", () => {
  test("returns one colour per step", () => {
    expect(gradientStops(["#000000", "#ffffff"], 5)).toHaveLength(5);
  });

  test("starts and ends on the stops", () => {
    const stops = gradientStops(["#000000", "#ffffff"], 3);
    expect(stops[0]).toBe("#000000");
    expect(stops[2]).toBe("#ffffff");
  });

  test("interpolates the midpoint", () => {
    expect(gradientStops(["#000000", "#ffffff"], 3)[1]).toBe("#808080");
  });

  test("a single stop repeats", () => {
    expect(gradientStops(["#123456"], 3)).toEqual(["#123456", "#123456", "#123456"]);
  });

  test("degenerate inputs do not throw", () => {
    expect(gradientStops([], 3)).toEqual([]);
    expect(gradientStops(["#fff"], 0)).toEqual([]);
  });

  test("expands three-digit hex", () => {
    expect(hexToRgb("#f0a")).toEqual({ r: 255, g: 0, b: 170 });
  });

  test("round-trips through hex", () => {
    expect(rgbToHex(hexToRgb("#22d3ee"))).toBe("#22d3ee");
  });
});

describe("progressStops", () => {
  test("resolves against the palette it is given", () => {
    const trueColour = progressStops(palette, 3);
    expect(trueColour[0]).toBe(palette.violet);
    expect(trueColour[2]).toBe(palette.pink);

    // A 256-colour terminal must get its own ramp, not true-colour values it
    // cannot display.
    const quantised = progressStops(fallback256, 3);
    expect(quantised[0]).toBe(fallback256.violet);
    expect(quantised[2]).toBe(fallback256.pink);
    expect(quantised[0]).not.toBe(palette.violet);
  });
});

describe("layoutMode", () => {
  test("two columns only on wide terminals", () => {
    expect(layoutMode(120, 30)).toBe("two-column");
    expect(layoutMode(99, 30)).toBe("single-column");
  });

  test("collapses in stages", () => {
    expect(layoutMode(80, 30)).toBe("single-column");
    expect(layoutMode(50, 30)).toBe("compact");
  });

  test("refuses below the minimum rather than rendering something unreadable", () => {
    expect(layoutMode(39, 30)).toBe("too-small");
    expect(layoutMode(80, 11)).toBe("too-small");
    expect(layoutMode(120, 13)).toBe("too-small");
  });

  test("a wide but short terminal gets the compact layout", () => {
    // The header pays for the mascot and the tagline. A terminal too short for
    // them gets the layout that has neither, rather than a header that eats the
    // list.
    expect(layoutMode(120, 16)).toBe("compact");
    expect(layoutMode(120, 19)).toBe("compact");
    expect(layoutMode(120, 20)).toBe("two-column");
  });

  test("the mascot disappears in compact mode", () => {
    expect(showsMascot("two-column")).toBe(true);
    expect(showsMascot("single-column")).toBe(true);
    expect(showsMascot("compact")).toBe(false);
    expect(showsMascot("too-small")).toBe(false);
  });
});

describe("the row budget", () => {
  test("the header pays for the mascot, which is taller than the wordmark", () => {
    // Five rows of face against two rows of wordmark. Forgetting this is exactly
    // how a list ends up painted over its own hint line.
    expect(headerRows("two-column")).toBe(1 + MASCOT.length);
    expect(headerRows("single-column")).toBe(1 + MASCOT.length);
    expect(headerRows("compact")).toBe(2);
  });

  test("a screen's list height is what is left after the chrome", () => {
    for (const mode of ["two-column", "single-column", "compact"] as const) {
      for (const screen of ["list", "panel", "editor"] as const) {
        const chrome = chromeRows(mode, screen);
        expect(listRows(chrome + 9, mode, screen)).toBe(9);
      }
    }
  });

  test("a list never budgets zero rows, however short the terminal", () => {
    expect(listRows(1, "compact")).toBeGreaterThanOrEqual(1);
    expect(listRows(-20, "two-column")).toBeGreaterThanOrEqual(1);
  });

  test("the budget is smaller than the screen it describes, or nothing fits", () => {
    expect(chromeRows("compact", "list")).toBeLessThanOrEqual(breakpoints.minRows);
  });
});
