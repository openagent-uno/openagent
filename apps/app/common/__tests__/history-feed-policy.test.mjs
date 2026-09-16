import assert from 'node:assert/strict';
import test from 'node:test';

import {
  historyCoversAllKinds,
  historyKindsForFilters,
  historyRequestKey,
  isTopLevelSidebarActivity,
  localSessionIdsMissingFromHistory,
  mergeBoundedHistory,
  sessionDiscoveryStrategy,
  sidebarActivityTitle,
} from '../history-feed-policy.ts';

function item(id, occurredAt) {
  return {
    id,
    kind: 'chat',
    resource_id: id,
    title: id,
    occurred_at: occurredAt,
    updated_at: occurredAt,
    live: false,
    completeness: 'complete',
  };
}

test('maps sidebar filters to canonical server kinds', () => {
  const all = historyKindsForFilters({ chat: true, workflow: true, task: true, event: true });
  assert.deepEqual(all, [
    'chat', 'workflow_run', 'scheduled_run', 'event_delivery',
  ]);
  assert.equal(historyCoversAllKinds(all), false);
  assert.equal(historyCoversAllKinds([
    'chat', 'delegated_session', 'workflow_run', 'scheduled_run', 'event_delivery',
  ]), true);
  assert.deepEqual(
    historyKindsForFilters({ chat: false, workflow: true, task: false, event: true }),
    ['workflow_run', 'event_delivery'],
  );
  assert.deepEqual(
    historyKindsForFilters({ chat: false, workflow: false, task: false, event: false }),
    [],
  );
});

test('flat Recent hides child sessions but keeps every first-class run', () => {
  const base = item('root', '2026-01-03T00:00:00Z');
  assert.equal(isTopLevelSidebarActivity(base), true);
  assert.equal(isTopLevelSidebarActivity({ ...base, kind: 'delegated_session' }), false);
  assert.equal(isTopLevelSidebarActivity({ ...base, origin: 'delegation' }), false);
  assert.equal(isTopLevelSidebarActivity({
    ...base,
    parent: { kind: 'session', id: 'parent', title: 'Parent' },
  }), false);
  for (const kind of ['workflow_run', 'scheduled_run', 'event_delivery']) {
    assert.equal(isTopLevelSidebarActivity({ ...base, kind }), true);
  }
});

test('Recent labels runs with their scheduled, workflow, or event parent name', () => {
  const base = item('activity', '2026-01-03T00:00:00Z');
  assert.equal(sidebarActivityTitle({
    ...base,
    kind: 'scheduled_run',
    title: 'Scheduled run ab12',
    parent: { kind: 'scheduled_task', id: 'task-1', title: 'Morning brief' },
  }), 'Morning brief');
  assert.equal(sidebarActivityTitle({
    ...base,
    kind: 'workflow_run',
    title: 'Workflow run cd34',
    parent: { kind: 'workflow', id: 'workflow-1', title: 'Publish release' },
  }), 'Publish release');
  assert.equal(sidebarActivityTitle({
    ...base,
    kind: 'event_delivery',
    title: 'Event delivery ef56',
    parent: { kind: 'event', id: 'event-1', title: 'Customer webhook' },
  }), 'Customer webhook');
  assert.equal(sidebarActivityTitle({
    ...base,
    kind: 'scheduled_run',
    title: 'Scheduled run fallback',
  }), 'Scheduled run fallback');
  assert.equal(sidebarActivityTitle({
    ...base,
    kind: 'scheduled_run',
    title: 'Scheduled run mixed version',
    parent: { kind: 'scheduled_task', id: 'task-legacy', title: 'task-legacy' },
  }), 'Scheduled run mixed version');
  assert.equal(sidebarActivityTitle(base), 'activity');
});

test('v2 Recent overlays unpersisted live chats without duplicating durable rows', () => {
  const durable = item('activity-durable', '2026-01-03T00:00:00Z');
  durable.session_id = 'session-durable';
  const delegated = {
    ...item('activity-child', '2026-01-03T00:00:00Z'),
    kind: 'delegated_session',
    session_id: 'session-child-indexed',
  };

  assert.deepEqual(localSessionIdsMissingFromHistory([
    { id: 'session-live' },
    { id: 'session-durable' },
    { id: 'session-child', origin: 'delegation', parentSessionId: 'session-parent' },
    { id: 'session-child-indexed', origin: 'delegation' },
    { id: 'scheduler:run', origin: 'scheduler' },
  ], [durable, delegated]), ['session-live']);
});

test('pagination deduplicates, sorts and caps retained history', () => {
  const first = [item('a', '2026-01-03T00:00:00Z'), item('b', '2026-01-02T00:00:00Z')];
  const next = [item('b', '2026-01-04T00:00:00Z'), item('c', '2026-01-01T00:00:00Z')];
  assert.deepEqual(
    mergeBoundedHistory(first, next, false, 3).map((entry) => entry.id),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    mergeBoundedHistory(first, next, true, 2).map((entry) => entry.id),
    ['b', 'c'],
  );
});

test('filter, reconnect generation and account changes invalidate stale responses', () => {
  const initial = historyRequestKey('account-a', ['chat'], 1);
  assert.notEqual(initial, historyRequestKey('account-a', ['workflow_run'], 1));
  assert.notEqual(initial, historyRequestKey('account-a', ['chat'], 2));
  assert.notEqual(initial, historyRequestKey('account-b', ['chat'], 1));
  assert.equal(initial, historyRequestKey('account-a', ['chat', 'chat'], 1));
});

test('reconnect discovery never requests the flat session list on v2', () => {
  assert.equal(sessionDiscoveryStrategy(2), 'history_page');
  assert.equal(sessionDiscoveryStrategy(1), 'legacy_sessions');
  assert.equal(sessionDiscoveryStrategy(undefined), 'legacy_sessions');
});
