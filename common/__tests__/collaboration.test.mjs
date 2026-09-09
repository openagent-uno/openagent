import assert from 'node:assert/strict';
import test from 'node:test';
import { validSharedSnapshot, validSharedTarget } from '../collaboration.ts';

test('collaboration accepts bounded replay with authenticated author', () => {
  assert.equal(validSharedSnapshot({ session_id: 'chat:1', revision: 1, turns: [{ id: 'turn', active: true, startedAt: 1,
    messages: [{ id: 'input', role: 'user', text: 'Hello', timestamp: 1, author: { kind: 'human', handle: 'alice' } }] }] }), true);
});

test('collaboration rejects invalid targets, oversized or malformed snapshots', () => {
  for (const target of [null, { kind: [], id: 'x' }, { kind: 'session', id: '../x' }, { kind: 'computer', id: 'x' }])
    assert.equal(validSharedTarget(target), false);
  for (const state of [null, { session_id: 's', revision: 1, turns: Array(9).fill({}) },
    { session_id: 's', revision: NaN, turns: [] }, { session_id: 's', revision: 0, turns: [{ id: 't', active: true, startedAt: 1, messages: [null] }] }]) {
    assert.equal(validSharedSnapshot(state), false);
  }
});
