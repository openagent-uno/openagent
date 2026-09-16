import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAWER_CONTENT_RETENTION_BUFFER_MS,
  DRAWER_MOTION_DURATION_MS,
  PHONE_DRAWER_CONTENT_RETENTION_MS,
  drawerContentRetentionDuration,
  drawerMotionDuration,
  resolvedDrawerWidth,
} from '../drawer-motion.ts';

test('permanent drawers reclaim layout width while overlay drawers retain it', () => {
  assert.equal(resolvedDrawerWidth(244, false, true), 244);
  assert.equal(resolvedDrawerWidth(244, false, false), 0);
  assert.equal(resolvedDrawerWidth(296, true, false), 296);
});

test('wide drawer motion respects reduced motion without truncating phone close', () => {
  assert.equal(drawerMotionDuration(false), DRAWER_MOTION_DURATION_MS);
  assert.equal(drawerMotionDuration(true), 0);
  assert.equal(
    drawerContentRetentionDuration(false, false),
    DRAWER_MOTION_DURATION_MS + DRAWER_CONTENT_RETENTION_BUFFER_MS,
  );
  assert.equal(
    drawerContentRetentionDuration(false, true),
    0,
  );
  assert.equal(
    drawerContentRetentionDuration(true, true),
    PHONE_DRAWER_CONTENT_RETENTION_MS,
  );
});
