import { describe, expect, test } from "bun:test";
import {
  clampCursor,
  cursorAfterFilter,
  filterBy,
  highlightRanges,
  indexOfKey,
  matches,
  moveCursor,
  segment,
  selectedKey,
  windowFor,
} from "../src/tui/list-state.ts";

const zones = [
  { id: "z1", name: "acme.com", group: "EU Sites" },
  { id: "z2", name: "brand-a.com", group: "Brand A" },
  { id: "z3", name: "acme-shop.com", group: "EU Sites" },
];

const haystacks = (zone: (typeof zones)[number]) => [zone.name, zone.id, zone.group];

describe("matching", () => {
  test("is a substring match, not fuzzy", () => {
    expect(matches("acme", ["acme.com"])).toBe(true);
    expect(matches("me.c", ["acme.com"])).toBe(true);
    // Fuzzy matching would accept this; substring matching must not.
    expect(matches("ameo", ["acme.com"])).toBe(false);
  });

  test("ignores case on both sides", () => {
    expect(matches("ACME", ["acme.com"])).toBe(true);
    expect(matches("acme", ["ACME.COM"])).toBe(true);
  });

  test("an empty or blank query matches everything", () => {
    expect(matches("", ["anything"])).toBe(true);
    expect(matches("   ", ["anything"])).toBe(true);
  });

  test("matches any of the item's fields", () => {
    expect(matches("z2", ["brand-a.com", "z2", "Brand A"])).toBe(true);
    expect(matches("brand a", ["brand-a.com", "z2", "Brand A"])).toBe(true);
  });
});

describe("filtering", () => {
  test("filters across name, id and group", () => {
    expect(filterBy(zones, "acme", haystacks).map((zone) => zone.id)).toEqual(["z1", "z3"]);
    expect(filterBy(zones, "Brand A", haystacks).map((zone) => zone.id)).toEqual(["z2"]);
    expect(filterBy(zones, "z3", haystacks).map((zone) => zone.id)).toEqual(["z3"]);
  });

  test("an empty query returns everything, as a copy", () => {
    const result = filterBy(zones, "", haystacks);
    expect(result).toEqual(zones);
    expect(result).not.toBe(zones);
  });

  test("no match is an empty list, not an error", () => {
    expect(filterBy(zones, "nothing-like-this", haystacks)).toEqual([]);
  });
});

describe("cursor movement", () => {
  test("moves within bounds", () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, -1, 3)).toBe(1);
  });

  test("clamps at both ends rather than wrapping", () => {
    expect(moveCursor(0, -1, 3)).toBe(0);
    expect(moveCursor(2, 1, 3)).toBe(2);
    expect(moveCursor(0, 100, 3)).toBe(2);
  });

  test("an empty list always has cursor 0", () => {
    expect(moveCursor(5, 1, 0)).toBe(0);
    expect(clampCursor(9, 0)).toBe(0);
  });

  test("clamping keeps the cursor inside a shrunken list", () => {
    expect(clampCursor(9, 3)).toBe(2);
    expect(clampCursor(-4, 3)).toBe(0);
  });
});

describe("selection", () => {
  const keyOf = (zone: (typeof zones)[number]) => zone.id;

  test("reports the key under the cursor", () => {
    expect(selectedKey(zones, 1, keyOf)).toBe("z2");
    expect(selectedKey(zones, 99, keyOf)).toBeNull();
    expect(selectedKey([], 0, keyOf)).toBeNull();
  });

  test("finds a key, or -1 when it is gone", () => {
    expect(indexOfKey(zones, "z3", keyOf)).toBe(2);
    expect(indexOfKey(zones, "nope", keyOf)).toBe(-1);
    expect(indexOfKey(zones, null, keyOf)).toBe(-1);
  });

  test("clearing a query restores the selection instead of jumping to the top", () => {
    // The scenario from decision U2: filter, select a row, clear the query.
    const filtered = filterBy(zones, "acme", haystacks);
    const index = indexOfKey(filtered, "z3", keyOf);
    expect(index).toBe(1);

    const cleared = filterBy(zones, "", haystacks);
    expect(indexOfKey(cleared, "z3", keyOf)).toBe(2);
  });

  test("a cursor left past the end of a filtered list lands at the top", () => {
    const filtered = filterBy(zones, "z3", haystacks);
    expect(cursorAfterFilter(filtered, 2, keyOf)).toBe(0);
  });

  test("a surviving selection is kept", () => {
    const filtered = filterBy(zones, "acme", haystacks);
    expect(cursorAfterFilter(filtered, 1, keyOf)).toBe(1);
  });
});

describe("windowing", () => {
  test("a list that fits is shown whole", () => {
    expect(windowFor(0, 3, 10)).toEqual({ start: 0, end: 3 });
  });

  test("keeps the cursor visible in the middle", () => {
    expect(windowFor(10, 100, 10)).toEqual({ start: 5, end: 15 });
  });

  test("never scrolls past the top or the bottom", () => {
    expect(windowFor(0, 100, 10)).toEqual({ start: 0, end: 10 });
    expect(windowFor(99, 100, 10)).toEqual({ start: 90, end: 100 });
  });

  test("a zero or negative height still yields a usable one-row window", () => {
    expect(windowFor(0, 5, 0)).toEqual({ start: 0, end: 1 });
    expect(windowFor(2, 5, -4)).toEqual({ start: 2, end: 3 });
  });

  test("an empty list yields an empty window", () => {
    expect(windowFor(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });
});

describe("highlighting", () => {
  test("finds every occurrence, case-insensitively", () => {
    expect(highlightRanges("acme.com/acme", "ACME")).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 13 },
    ]);
  });

  test("overlapping-ish repeats advance past each hit", () => {
    expect(highlightRanges("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  test("no query means no ranges", () => {
    expect(highlightRanges("acme.com", "")).toEqual([]);
    expect(highlightRanges("acme.com", "   ")).toEqual([]);
  });

  test("segmenting splits into alternating runs that rejoin to the original", () => {
    const segments = segment("acme-shop.com", "shop");
    expect(segments).toEqual([
      { text: "acme-", hit: false },
      { text: "shop", hit: true },
      { text: ".com", hit: false },
    ]);
    expect(segments.map((part) => part.text).join("")).toBe("acme-shop.com");
  });

  test("segmenting with no query returns the whole string as one miss", () => {
    expect(segment("acme.com", "")).toEqual([{ text: "acme.com", hit: false }]);
  });

  test("segmenting a query that matches everything marks it whole", () => {
    expect(segment("acme", "acme")).toEqual([{ text: "acme", hit: true }]);
  });

  test("segmenting handles a hit at the very end", () => {
    expect(segment("acme.com", "com")).toEqual([
      { text: "acme.", hit: false },
      { text: "com", hit: true },
    ]);
  });

  test("segmenting an empty string yields nothing to paint", () => {
    expect(segment("", "acme")).toEqual([]);
  });
});
