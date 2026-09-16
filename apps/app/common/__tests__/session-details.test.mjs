import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RUN_LIVE_POLL_MAX_ATTEMPTS,
  RUN_LIVE_POLL_MAX_DURATION_MS,
  mergeSessionHierarchyRows,
  planRunRelationRefresh,
  runLivePollDelay,
  shouldContinueRunPolling,
} from '../session-details.ts';

test('live polling stops on terminal status and at both hard limits', () => {
  assert.equal(shouldContinueRunPolling('running', 1_000, 1), true);
  assert.equal(shouldContinueRunPolling('completed', 1_000, 1), false);
  assert.equal(shouldContinueRunPolling(
    'running', RUN_LIVE_POLL_MAX_DURATION_MS, 1,
  ), false);
  assert.equal(shouldContinueRunPolling(
    'running', 1_000, RUN_LIVE_POLL_MAX_ATTEMPTS,
  ), false);
  assert.equal(runLivePollDelay(1), 2_000);
  assert.equal(runLivePollDelay(30), 5_000);
});

test('relation refresh prioritizes newly discovered roots within its request cap', () => {
  const plan = planRunRelationRefresh({
    sessionIds: ['primary', 'trace-a', 'trace-b', 'trace-b'],
    hydratedSessionIds: new Set(['primary']),
    roundRobinCursor: 0,
    pollAttempt: 1,
    sourceLimit: 2,
  });

  assert.deepEqual(plan.sourceIds, ['trace-a', 'trace-b']);
});

test('known roots refresh on one bounded round-robin loop, not every detail poll', () => {
  const args = {
    sessionIds: ['primary', 'trace-a', 'trace-b'],
    hydratedSessionIds: new Set(['primary', 'trace-a', 'trace-b']),
    sourceLimit: 2,
  };
  assert.deepEqual(planRunRelationRefresh({
    ...args, roundRobinCursor: 0, pollAttempt: 2,
  }).sourceIds, []);

  const first = planRunRelationRefresh({
    ...args, roundRobinCursor: 0, pollAttempt: 3,
  });
  assert.deepEqual(first.sourceIds, ['primary', 'trace-a']);
  const second = planRunRelationRefresh({
    ...args, roundRobinCursor: first.nextRoundRobinCursor, pollAttempt: 6,
  });
  assert.deepEqual(second.sourceIds, ['trace-b', 'primary']);
});

test('hierarchy merging retains depth and never removes a redacted-lineage flag', () => {
  const merged = mergeSessionHierarchyRows([
    { id: 'child', depth: 3, lineageRedacted: true, title: 'old' },
  ], [
    { id: 'child', depth: 2, lineageRedacted: false, title: 'fresh' },
  ]);

  assert.deepEqual(merged, [
    { id: 'child', depth: 2, lineageRedacted: true, title: 'fresh' },
  ]);
});

test('the right drawer stays below Expo Router and is mounted only by detail-capable routes', () => {
  const tabsLayout = readFileSync(
    new URL('../../universal/app/(tabs)/_layout.tsx', import.meta.url),
    'utf8',
  );
  const chat = readFileSync(
    new URL('../../universal/app/(tabs)/chat.tsx', import.meta.url),
    'utf8',
  );
  const run = readFileSync(
    new URL('../../universal/app/(tabs)/runs/[id].tsx', import.meta.url),
    'utf8',
  );
  const drawer = readFileSync(
    new URL('../../universal/components/SessionDetailsDrawer.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(tabsLayout, /SessionDetailsDrawerShell/);
  assert.match(chat, /<SessionDetailsDrawerShell topInset=\{headerInset\}>/);
  assert.match(run, /<SessionDetailsDrawerShell topInset=\{headerInset\}>/);
  assert.match(drawer, /<NavigationIndependentTree>/);
  assert.match(drawer, /<NavigationContainer documentTitle=\{\{ enabled: false \}\}>/);
  assert.match(drawer, /defaultStatus=\{isOpen \? 'open' : 'closed'\}/);
  assert.match(drawer, /drawerType: layout\.isPhone \? 'front' : 'permanent'/);
  assert.match(drawer, /webDrawerWidthTransition\(isResizing \? 0 : motionDuration\)/);
  assert.match(drawer, /useRetainedPresence\(/);
  assert.match(tabsLayout, /webDrawerWidthTransition\(isResizing \? 0 : motionDuration\)/);
  assert.match(tabsLayout, /testID="navigation-drawer-content"/);
  assert.match(drawer, /const onNavigate = isPhone \? requestClose : undefined/);
  assert.match(drawer, /Math\.max\(topInset, isPhone \? insets\.top : 0\)/);
  assert.doesNotMatch(chat, /closeSessionDetails/);
  assert.doesNotMatch(run, /closeSessionDetails/);
  assert.match(drawer, /state\.historyRevision/);
  assert.doesNotMatch(drawer, /state\.historyGeneration/);
  assert.match(drawer, /depth: Math\.max\(1, item\.depth\)/);
  assert.match(drawer, /lineageRedacted: item\.lineage_redacted/);
});
