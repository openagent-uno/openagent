import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NAVIGATION_DRAWER_MIN_WIDTH,
  SESSION_DETAILS_DRAWER_MAX_WIDTH,
  clampDrawerWidth,
  drawerKeyboardStep,
  hardDrawerWidthBounds,
  resizedDrawerWidth,
  responsiveDrawerWidthBounds,
} from '../drawer-resize.ts';

test('drawer widths clamp to hard and viewport-aware bounds', () => {
  const navigation = hardDrawerWidthBounds('navigation');
  assert.equal(clampDrawerWidth(40, navigation), NAVIGATION_DRAWER_MIN_WIDTH);
  assert.equal(clampDrawerWidth(Number.NaN, navigation), NAVIGATION_DRAWER_MIN_WIDTH);
  assert.equal(clampDrawerWidth(9999, hardDrawerWidthBounds('session-details')), SESSION_DETAILS_DRAWER_MAX_WIDTH);

  const constrained = responsiveDrawerWidthBounds('session-details', 800, {
    otherDrawerOpen: true,
    otherDrawerWidth: 244,
  });
  assert.deepEqual(constrained, { min: 280, max: 376 });
  const left = responsiveDrawerWidthBounds('navigation', 800, {
    otherDrawerOpen: true,
    otherDrawerWidth: 344,
  });
  assert.deepEqual(left, { min: 220, max: 276 });
  assert.ok(left.max + 344 <= 800 - 180);
  assert.ok(constrained.max + 244 <= 800 - 180);

  assert.deepEqual(
    responsiveDrawerWidthBounds('navigation', 800, { otherDrawerOpen: false, otherDrawerWidth: 344 }),
    { min: 220, max: 420 },
  );
});

test('cursor movement grows the drawer on the boundary side', () => {
  const bounds = { min: 200, max: 500 };
  assert.equal(resizedDrawerWidth(300, 40, 'left', bounds), 340);
  assert.equal(resizedDrawerWidth(300, 40, 'right', bounds), 260);
  assert.equal(resizedDrawerWidth(300, -999, 'left', bounds), 200);
});

test('keyboard resize mirrors pointer direction and supports endpoints', () => {
  const bounds = { min: 220, max: 420 };
  assert.equal(drawerKeyboardStep(300, 'ArrowRight', 'left', bounds), 312);
  assert.equal(drawerKeyboardStep(300, 'ArrowRight', 'right', bounds), 288);
  assert.equal(drawerKeyboardStep(300, 'Home', 'left', bounds), 220);
  assert.equal(drawerKeyboardStep(300, 'End', 'right', bounds), 420);
  assert.equal(drawerKeyboardStep(300, 'Enter', 'left', bounds), null);
});
