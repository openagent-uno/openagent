import assert from 'node:assert/strict';
import test from 'node:test';
import { computerFrame, screenCoordinate } from '../devices.ts';

test('screen metadata and content stay paired and coordinate scaling uses rendered image space', () => {
  const frame = computerFrame({ content: [
    { type: 'text', text: 'another block' },
    { type: 'text', text: JSON.stringify({ image_width: 1600, image_height: 900 }) },
    { type: 'image', mimeType: 'image/png', data: 'fixture' },
  ] });
  assert.equal(frame.uri, 'data:image/png;base64,fixture');
  assert.deepEqual(screenCoordinate(200, 100, 800, frame), [400, 200]);
  assert.deepEqual(screenCoordinate(800, 450, 800, frame), [1599, 899]);
  assert.deepEqual(screenCoordinate(-2, -3, 800, frame), [0, 0]);
});

test('missing geometry, provider failures and invalid image content never create clickable screens', () => {
  assert.throws(() => computerFrame({ isError: true, content: [{ type: 'text', text: 'Screen permission denied' }] }), /permission denied/);
  assert.throws(() => computerFrame({ content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] }), /dimensions/);
  assert.equal(computerFrame({ content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'fixture' }] }), null);
  assert.equal(computerFrame({ content: [{ type: 'text', text: 'click complete' }] }), null);
});
