import { modifiedMillis, sortNotesByModified } from '../noteSort';
import { strict as assert } from 'node:assert';

assert.equal(modifiedMillis('2026-11-13T10:00:00Z'), Date.parse('2026-11-13T10:00:00Z'));
assert.equal(modifiedMillis(1794571200), 1794571200 * 1000);
assert.equal(modifiedMillis(1794571200000), 1794571200000);
assert.equal(modifiedMillis('1794571200'), 1794571200 * 1000);
assert.equal(modifiedMillis(undefined), 0);
assert.equal(modifiedMillis('not a date'), 0);

const sorted = sortNotesByModified([
  { path: 'a.md', title: 'a', tags: [], modified: 1700000000 as unknown as string },
  { path: 'b.md', title: 'b', tags: [], modified: '2026-11-13T10:00:00Z' },
  { path: 'c.md', title: 'c', tags: [], modified: '' },
]);
assert.deepEqual(sorted.map((n) => n.path), ['b.md', 'a.md', 'c.md']);
console.log('note-sort: all tests passed');
