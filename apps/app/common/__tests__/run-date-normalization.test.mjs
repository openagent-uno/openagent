import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeLegacyRunDates,
  normalizeRunTimestamp,
} from '../run-date-normalization.ts';

const START_ISO = '2026-08-28T10:00:00.000Z';
const FINISH_ISO = '2026-08-28T10:00:02.500Z';
const START_SECONDS = Date.parse(START_ISO) / 1000;
const FINISH_SECONDS = Date.parse(FINISH_ISO) / 1000;

test('workflow detail prefers server ISO mirrors over inconsistent legacy epochs', () => {
  const run = normalizeLegacyRunDates({
    started_at: 1,
    finished_at: 2,
    started_at_iso: START_ISO,
    finished_at_iso: FINISH_ISO,
  });

  assert.equal(run.started_at, START_SECONDS);
  assert.equal(run.finished_at, FINISH_SECONDS);
  assert.equal(run.finished_at - run.started_at, 2.5);
  assert.equal(run.started_at_iso, START_ISO);
  assert.doesNotMatch(run.started_at_iso, /^1970-/);
});

test('event detail turns epoch seconds into a real ISO date, not a 1970 date', () => {
  const delivery = normalizeLegacyRunDates({
    started_at: START_SECONDS,
    finished_at: FINISH_SECONDS,
  });

  assert.equal(delivery.started_at, START_SECONDS);
  assert.equal(delivery.finished_at, FINISH_SECONDS);
  assert.equal(delivery.started_at_iso, START_ISO);
  assert.equal(delivery.finished_at_iso, FINISH_ISO);
});

test('scheduled detail accepts canonical ISO values and preserves second durations', () => {
  const run = normalizeLegacyRunDates({
    started_at: START_ISO,
    finished_at: FINISH_ISO,
  });

  assert.equal(run.started_at, START_SECONDS);
  assert.equal(run.finished_at, FINISH_SECONDS);
  assert.equal(run.finished_at - run.started_at, 2.5);
});

test('epoch milliseconds and numeric strings normalize to the same timestamp', () => {
  assert.deepEqual(normalizeRunTimestamp(Date.parse(START_ISO)), {
    epochSeconds: START_SECONDS,
    iso: START_ISO,
  });
  assert.deepEqual(normalizeRunTimestamp(String(START_SECONDS)), {
    epochSeconds: START_SECONDS,
    iso: START_ISO,
  });
  const pre2001 = '2000-01-01T00:00:00.000Z';
  assert.equal(
    normalizeRunTimestamp(Date.parse(pre2001))?.iso,
    pre2001,
  );
});

test('invalid ISO mirrors fall back, while an explicit null finish stays live', () => {
  const fallback = normalizeLegacyRunDates({
    started_at: START_SECONDS,
    finished_at: FINISH_SECONDS,
    started_at_iso: 'not-a-date',
    finished_at_iso: null,
  });

  assert.equal(fallback.started_at_iso, START_ISO);
  assert.equal(fallback.finished_at, null);
  assert.equal(fallback.finished_at_iso, null);
});
