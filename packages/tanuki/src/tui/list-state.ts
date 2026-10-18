/**
 * List behaviour: cursor movement, filtering, highlighting, windowing
 * (decision U2).
 *
 * Deliberately a pure module with no React in it. The three lists in the
 * interface — configurations, zones, groups — all need identical rules, and the
 * rules have sharp edges worth testing directly:
 *
 *  - filtering must be a case-insensitive *substring* match, not fuzzy, so the
 *    user can reason about why a row did or did not appear;
 *  - clearing the query must restore the selection to whatever was selected
 *    before, not jump to the top;
 *  - the cursor must never point past the end of a list that shrank.
 */

export interface Range {
  start: number;
  end: number;
}

/** Case-insensitive substring match against any of the item's fields. */
export function matches(query: string, haystacks: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return haystacks.some((haystack) => haystack.toLowerCase().includes(needle));
}

export function filterBy<T>(
  items: readonly T[],
  query: string,
  haystacks: (item: T) => readonly string[],
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...items];
  return items.filter((item) => haystacks(item).some((haystack) => haystack.toLowerCase().includes(needle)));
}

/** Clamps rather than wraps: wrapping past the end of a long list is disorienting. */
export function moveCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, cursor + delta), length - 1);
}

export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, cursor), length - 1);
}

export function indexOfKey<T>(items: readonly T[], key: string | null, keyOf: (item: T) => string): number {
  if (key === null) return -1;
  return items.findIndex((item) => keyOf(item) === key);
}

/**
 * Where the cursor should land after a filter change.
 *
 * If the previously selected item survived the filter, stay on it. Otherwise
 * fall back to the top — never to a stale index that now points at a different
 * row, which is how a filter change makes you purge the wrong zone.
 */
export function cursorAfterFilter<T>(
  filtered: readonly T[],
  previousIndex: number,
  keyOf: (item: T) => string,
): number {
  if (filtered.length === 0) return 0;
  if (previousIndex >= 0 && previousIndex < filtered.length) return previousIndex;
  return 0;
}

export function selectedKey<T>(items: readonly T[], cursor: number, keyOf: (item: T) => string): string | null {
  const item = items[cursor];
  return item === undefined ? null : keyOf(item);
}

/**
 * The slice of the list to paint, keeping the cursor centred where possible and
 * never scrolling past either end.
 */
export function windowFor(cursor: number, length: number, height: number): { start: number; end: number } {
  const size = Math.max(1, Math.floor(height));
  if (length <= size) return { start: 0, end: Math.max(0, length) };

  const half = Math.floor(size / 2);
  const start = Math.min(Math.max(0, cursor - half), length - size);
  return { start, end: start + size };
}

/** Every occurrence of the query within the text, for painting highlights. */
export function highlightRanges(text: string, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const haystack = text.toLowerCase();
  const ranges: Range[] = [];
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    ranges.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + needle.length);
  }

  return ranges;
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Splits text into alternating hit/miss runs so the renderer can colour them. */
export function segment(text: string, query: string): Segment[] {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return text.length === 0 ? [] : [{ text, hit: false }];

  const segments: Segment[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), hit: false });
    segments.push({ text: text.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
