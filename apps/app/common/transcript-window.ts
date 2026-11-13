/**
 * Transcript windowing — pure helpers shared by the chat store and the
 * transcript renderer.
 *
 * A long session is never loaded or rendered whole. The store keeps the
 * canonical pages it has fetched plus a list of *loaded ranges*: ordinal
 * intervals known to be contiguous (every user-visible message whose ordinal
 * falls inside the interval is present). ``null`` bounds are open: a range
 * starting at ``null`` reaches the first message of the session, one ending
 * at ``null`` reaches the live tail. Two loaded messages that no single range
 * covers have unloaded history between them — a *gap* the renderer must never
 * paint across, and which it fills by fetching from either side.
 *
 * The renderer then shows a bounded window of rows inside one contiguous
 * segment, sliding it as the reader scrolls in either direction.
 */

export interface LoadedRange {
  /** Lowest covered ordinal, or ``null`` when the range reaches the first message. */
  start: number | null;
  /** Highest covered ordinal, or ``null`` when the range reaches the live tail. */
  end: number | null;
}

interface PageShape {
  messages: readonly { ordinal: number }[];
  has_more_before: boolean;
  has_more_after: boolean;
}

interface OrderedRow {
  id: string;
  ordinal?: number;
}

const lower = (value: number | null) => (value == null ? -Infinity : value);
const upper = (value: number | null) => (value == null ? Infinity : value);

/** The contiguous interval one canonical page proves to be loaded. */
export function pageLoadedRange(page: PageShape): LoadedRange | null {
  if (!page.messages.length) {
    // An empty, complete page proves the session is empty end to end.
    return !page.has_more_before && !page.has_more_after ? { start: null, end: null } : null;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const message of page.messages) {
    if (message.ordinal < min) min = message.ordinal;
    if (message.ordinal > max) max = message.ordinal;
  }
  return {
    start: page.has_more_before ? min : null,
    end: page.has_more_after ? max : null,
  };
}

/** Union ``add`` into sorted disjoint ranges, merging every overlap. */
export function mergeLoadedRanges(
  ranges: readonly LoadedRange[] | undefined,
  add: LoadedRange | null | undefined,
): LoadedRange[] {
  const all = [...(ranges ?? []), ...(add ? [add] : [])]
    .sort((a, b) => lower(a.start) - lower(b.start));
  const merged: LoadedRange[] = [];
  for (const range of all) {
    const last = merged.at(-1);
    if (last && lower(range.start) <= upper(last.end)) {
      if (upper(range.end) > upper(last.end)) last.end = range.end;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/** Clip every range to ``maxOrdinal`` (inclusive), dropping emptied ranges.
 * Used before a tail reload replaces the rows above the previous canonical
 * tail: the old open-ended tail range only proves what was actually loaded. */
export function clipLoadedRanges(
  ranges: readonly LoadedRange[] | undefined,
  maxOrdinal: number | null,
): LoadedRange[] {
  if (maxOrdinal == null) return [];
  const clipped: LoadedRange[] = [];
  for (const range of ranges ?? []) {
    if (lower(range.start) > maxOrdinal) continue;
    clipped.push({ start: range.start, end: upper(range.end) > maxOrdinal ? maxOrdinal : range.end });
  }
  return clipped;
}

function rangeIndexFor(ranges: readonly LoadedRange[], ordinal: number): number {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (ordinal >= lower(range.start) && ordinal <= upper(range.end)) return index;
  }
  return -1;
}

/** Effective ordinals: a row without one (a live/optimistic row, or a split
 * of a canonical reply) belongs with the closest preceding ordinal. */
export function effectiveOrdinals(rows: readonly OrderedRow[]): (number | null)[] {
  let previous: number | null = null;
  return rows.map((row) => {
    if (typeof row.ordinal === 'number') previous = row.ordinal;
    return previous;
  });
}

/**
 * ``gaps[i]`` is true when unloaded history sits between ``rows[i]`` and
 * ``rows[i + 1]``. Without range metadata (legacy history, or a session that
 * only ever saw live frames) the transcript is treated as contiguous.
 */
export function transcriptGaps(
  rows: readonly OrderedRow[],
  ranges: readonly LoadedRange[] | undefined,
): boolean[] {
  const gaps = new Array<boolean>(rows.length).fill(false);
  if (!ranges?.length || rows.length < 2) return gaps;
  const ordinals = effectiveOrdinals(rows);
  for (let index = 0; index + 1 < rows.length; index += 1) {
    const a = ordinals[index];
    const b = ordinals[index + 1];
    if (a == null || b == null || a === b) continue;
    const range = rangeIndexFor(ranges, a);
    gaps[index] = range < 0 || b > upper(ranges[range].end);
  }
  return gaps;
}

/** True when the server holds history older than the first loaded row. */
export function hasHistoryBefore(
  rows: readonly OrderedRow[],
  ranges: readonly LoadedRange[] | undefined,
  fallback = false,
): boolean {
  if (!ranges?.length) return fallback;
  const first = effectiveOrdinals(rows).find((ordinal) => ordinal != null);
  if (first == null) return ranges[0].start != null;
  const range = rangeIndexFor(ranges, first);
  return range < 0 || ranges[range].start != null;
}

/** Inclusive bounds of the contiguous segment containing ``index``. */
export function segmentBounds(gaps: readonly boolean[], index: number): [number, number] {
  if (!gaps.length) return [0, -1];
  const at = Math.max(0, Math.min(index, gaps.length - 1));
  let start = at;
  while (start > 0 && !gaps[start - 1]) start -= 1;
  let end = at;
  while (end < gaps.length - 1 && !gaps[end]) end += 1;
  return [start, end];
}

/** Canonical message id of a rendered row (split replies carry a suffix). */
export function canonicalRowId(id: string): string {
  return id.split(':after:')[0];
}

/** First row at or after ``index`` (within ``limit``) carrying an ordinal. */
export function ordinalRowAtOrAfter(rows: readonly OrderedRow[], index: number, limit: number): number {
  for (let i = index; i <= limit && i < rows.length; i += 1) {
    if (typeof rows[i].ordinal === 'number') return i;
  }
  return -1;
}

/** Last row at or before ``index`` (down to ``limit``) carrying an ordinal. */
export function ordinalRowAtOrBefore(rows: readonly OrderedRow[], index: number, limit: number): number {
  for (let i = Math.min(index, rows.length - 1); i >= limit && i >= 0; i -= 1) {
    if (typeof rows[i].ordinal === 'number') return i;
  }
  return -1;
}

/** A window edge remembered by id, with the ordinal as a fallback when the
 * row is replaced (a live row reconciled into its canonical twin). */
export interface WindowEdge {
  id: string;
  ordinal?: number;
}

export function edgeOf(rows: readonly OrderedRow[], index: number): WindowEdge | null {
  const row = rows[index];
  if (!row) return null;
  const ordinal = effectiveOrdinals(rows.slice(0, index + 1)).at(-1);
  return { id: row.id, ...(ordinal != null ? { ordinal } : {}) };
}

/** Resolve a remembered edge to a row index, or -1 when it cannot be found. */
export function resolveEdge(
  rows: readonly OrderedRow[],
  edge: WindowEdge,
  side: 'start' | 'end',
): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].id === edge.id) return i;
  if (edge.ordinal == null) return -1;
  const ordinals = effectiveOrdinals(rows);
  if (side === 'start') {
    for (let i = 0; i < rows.length; i += 1) {
      const ordinal = ordinals[i];
      if (ordinal != null && ordinal >= edge.ordinal) return i;
    }
    return -1;
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const ordinal = ordinals[i];
    if (ordinal != null && ordinal <= edge.ordinal) return i;
  }
  return -1;
}

export interface WindowState {
  /** ``null`` = the default tail window. */
  start: WindowEdge | null;
  /** ``null`` = follow the live tail. */
  end: WindowEdge | null;
}

export interface ResolvedWindow {
  start: number;
  end: number;
  segmentStart: number;
  segmentEnd: number;
  /** The window ends on the last row of the transcript and follows new rows. */
  followsTail: boolean;
}

/** Resolve a window to row indexes, clamped inside one contiguous segment. */
export function resolveWindow(
  rows: readonly OrderedRow[],
  gaps: readonly boolean[],
  state: WindowState,
  size: number,
): ResolvedWindow {
  const last = rows.length - 1;
  if (last < 0) return { start: 0, end: -1, segmentStart: 0, segmentEnd: -1, followsTail: true };
  let end = state.end ? resolveEdge(rows, state.end, 'end') : last;
  if (end < 0) end = last;
  const [segmentStart, segmentEnd] = segmentBounds(gaps, end);
  let start = state.start ? resolveEdge(rows, state.start, 'start') : -1;
  if (start < 0 || start > end) start = Math.max(segmentStart, end - size + 1);
  start = Math.max(start, segmentStart);
  return { start, end, segmentStart, segmentEnd, followsTail: end === last && state.end == null };
}
