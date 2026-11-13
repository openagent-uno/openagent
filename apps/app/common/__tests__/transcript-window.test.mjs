import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clipLoadedRanges,
  hasHistoryBefore,
  mergeLoadedRanges,
  pageLoadedRange,
  resolveWindow,
  segmentBounds,
  transcriptGaps,
} from '../transcript-window.ts';

const rows = (...ordinals) => ordinals.map((ordinal, index) => ({
  id: `m${index}`, ...(ordinal == null ? {} : { ordinal }),
}));
const page = (ordinals, before, after) => ({
  messages: ordinals.map((ordinal) => ({ ordinal })), has_more_before: before, has_more_after: after,
});

test('a page proves the interval it covers, open where nothing remains', () => {
  assert.deepEqual(pageLoadedRange(page([10, 11, 12], true, false)), { start: 10, end: null });
  assert.deepEqual(pageLoadedRange(page([3, 9], false, true)), { start: null, end: 9 });
  assert.deepEqual(pageLoadedRange(page([], false, false)), { start: null, end: null });
  assert.equal(pageLoadedRange(page([], true, false)), null);
});

test('overlapping ranges merge; disjoint ones stay apart', () => {
  const tail = { start: 100, end: null };
  const jump = { start: 20, end: 60 };
  assert.deepEqual(mergeLoadedRanges([tail], jump), [jump, tail]);
  // Paging forward from the jumped range until it overlaps the tail.
  assert.deepEqual(mergeLoadedRanges([jump, tail], { start: 60, end: 120 }), [{ start: 20, end: null }]);
  // Paging back to the first message opens the start.
  assert.deepEqual(mergeLoadedRanges([{ start: 20, end: null }], { start: null, end: 20 }), [{ start: null, end: null }]);
});

test('a tail reload only trusts what was loaded before it', () => {
  assert.deepEqual(clipLoadedRanges([{ start: 5, end: null }], 40), [{ start: 5, end: 40 }]);
  assert.deepEqual(clipLoadedRanges([{ start: 50, end: 60 }, { start: 5, end: 9 }], 40), [{ start: 5, end: 9 }]);
  assert.deepEqual(clipLoadedRanges([{ start: 5, end: null }], null), []);
});

test('gaps appear only between rows no loaded range connects', () => {
  const ranges = [{ start: 20, end: 25 }, { start: 100, end: null }];
  // Live rows without an ordinal inherit the previous one and join the tail.
  const list = rows(20, 22, 25, 100, 101, null, null);
  assert.deepEqual(transcriptGaps(list, ranges), [false, false, true, false, false, false, false]);
  assert.deepEqual(segmentBounds(transcriptGaps(list, ranges), 4), [3, 6]);
  assert.deepEqual(segmentBounds(transcriptGaps(list, ranges), 1), [0, 2]);
  // Without range metadata the transcript is contiguous.
  assert.deepEqual(transcriptGaps(list, undefined), new Array(7).fill(false));
});

test('older history exists unless the first range reaches the session start', () => {
  assert.equal(hasHistoryBefore(rows(20, 21), [{ start: 20, end: null }]), true);
  assert.equal(hasHistoryBefore(rows(0, 1), [{ start: null, end: null }]), false);
  assert.equal(hasHistoryBefore(rows(null), undefined, true), true);
});

test('the window follows the tail by default and stays inside one segment', () => {
  const list = rows(...Array.from({ length: 200 }, (_, i) => i));
  const contiguous = transcriptGaps(list, [{ start: 0, end: null }]);
  const tail = resolveWindow(list, contiguous, { start: null, end: null }, 60);
  assert.deepEqual([tail.start, tail.end, tail.followsTail], [140, 199, true]);

  // After a jump far back the store holds two segments with a gap between.
  const jumpedList = rows(...Array.from({ length: 50 }, (_, i) => i), ...Array.from({ length: 50 }, (_, i) => 150 + i));
  const split = transcriptGaps(jumpedList, [{ start: 0, end: 49 }, { start: 150, end: null }]);
  const jumped = resolveWindow(jumpedList, split, { start: { id: 'm10' }, end: { id: 'm40' } }, 60);
  assert.deepEqual([jumped.start, jumped.end, jumped.segmentStart, jumped.segmentEnd, jumped.followsTail],
    [10, 40, 0, 49, false]);
  const across = resolveWindow(jumpedList, split, { start: { id: 'm10' }, end: { id: 'm70' } }, 60);
  assert.equal(across.start, 50, 'the window never paints across unloaded history');
  assert.equal(across.segmentEnd, 99);

  // An edge whose row was replaced resolves by ordinal.
  const replaced = list.map((row) => (row.id === 'm120' ? { ...row, id: 'canonical-120' } : row));
  const byOrdinal = resolveWindow(replaced, contiguous, { start: { id: 'm120', ordinal: 120 }, end: null }, 60);
  assert.equal(byOrdinal.start, 120);
});
