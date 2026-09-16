import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canInvokeUIViewAction,
  normalizeAttachmentRefs,
  normalizeMessageParts,
  normalizeMessageContent,
  resolveUIBinding,
} from '../ui-views.ts';

test('OA-UI action capability accepts only an explicit authenticated grant', () => {
  assert.equal(canInvokeUIViewAction(true, 'refresh'), true);
  assert.equal(canInvokeUIViewAction(false, 'refresh'), false);
  assert.equal(canInvokeUIViewAction(undefined, 'refresh'), false);
  assert.equal(canInvokeUIViewAction(1, 'refresh'), false);
  assert.equal(canInvokeUIViewAction('true', 'refresh'), false);
  assert.equal(canInvokeUIViewAction(true, ''), false);
});

test('CAS attachment refs preserve identity, metadata and canonical URL without a path alias', () => {
  assert.deepEqual(normalizeAttachmentRefs([
    {
      artifact_id: 'artifact/opaque', artifact_link_id: 'link-1', kind: 'image',
      filename: 'photo.png', mime_type: 'image/png', size_bytes: 42,
      sha256: 'abc123', path: '/private/cas/should-not-leak',
    },
    { artifactId: 'file-2', type: 'file', name: 'report.pdf', url: '/api/artifacts/file-2/content' },
  ]), [
    {
      type: 'image', filename: 'photo.png', artifact_id: 'artifact/opaque',
      artifact_link_id: 'link-1', url: '/api/artifacts/artifact%2Fopaque/content',
      mime_type: 'image/png', size_bytes: 42, sha256: 'abc123',
    },
    { type: 'file', filename: 'report.pdf', artifact_id: 'file-2', url: '/api/artifacts/file-2/content' },
  ]);
});

test('OA-UI bindings resolve RFC 6901 pointers without expressions', () => {
  const data = { metrics: { 'cpu/load': [0.12, 0.42], nested: { '~key': 'ok' } } };
  assert.equal(resolveUIBinding({ $bind: { source: 'metrics', path: '/cpu~1load/1' } }, data), 0.42);
  assert.equal(resolveUIBinding({ $bind: { source: 'metrics', path: '/nested/~0key' } }, data), 'ok');
  assert.equal(resolveUIBinding({ $bind: { source: 'metrics', path: 'constructor.constructor' }, fallback: 'safe' }, data), 'safe');
  assert.equal(resolveUIBinding({ $bind: { source: 'missing', path: '' }, fallback: 7 }, data), 7);
});

test('documented data and state binding roots resolve without eval', () => {
  const context = {
    cpu: { percent: 42 },
    state: { range: '7d' },
  };
  assert.equal(resolveUIBinding({ $bind: { source: 'data', path: '/cpu/percent' } }, context), 42);
  assert.equal(resolveUIBinding({ $bind: { source: 'state', path: '/range' } }, context), '7d');
});

test('ordered parts preserve order and accept beta aliases', () => {
  const parts = normalizeMessageParts([
    { type: 'text', text: 'Before' },
    { type: 'ui_view', viewId: 'view-1', revision: '3' },
    { kind: 'attachment', attachment: { kind: 'file', artifact_id: 'a-1', filename: 'report.pdf' } },
    { kind: 'text', text: 'After' },
  ]);
  assert.deepEqual(parts, [
    { kind: 'text', text: 'Before' },
    { kind: 'ui_view', view_id: 'view-1', revision: 3 },
    {
      kind: 'attachment',
      attachment: {
        type: 'file', filename: 'report.pdf', artifact_id: 'a-1',
        url: '/api/artifacts/a-1/content',
      },
    },
    { kind: 'text', text: 'After' },
  ]);
});

test('authoritative mixed parts retain text, image, UI and file ordering exactly once', () => {
  const parts = normalizeMessageContent([
    { kind: 'text', text: 'Live report' },
    {
      kind: 'image', artifact_id: 'chart-1', filename: 'chart.png',
      mime_type: 'image/png',
    },
    { kind: 'ui_view', view_id: 'dashboard-1', revision: 6 },
    {
      kind: 'attachment',
      attachment: { type: 'file', artifact_id: 'report-1', filename: 'report.pdf' },
    },
    { kind: 'text', text: 'End of report' },
  ], undefined, 'legacy text must not be duplicated', [{
    type: 'file', path: '/tmp/legacy.txt', filename: 'legacy.txt',
  }]);

  assert.deepEqual(parts, [
    { kind: 'text', text: 'Live report' },
    {
      kind: 'attachment',
      attachment: {
        type: 'image', filename: 'chart.png', artifact_id: 'chart-1',
        url: '/api/artifacts/chart-1/content', mime_type: 'image/png',
      },
    },
    { kind: 'ui_view', view_id: 'dashboard-1', revision: 6 },
    {
      kind: 'attachment',
      attachment: {
        type: 'file', filename: 'report.pdf', artifact_id: 'report-1',
        url: '/api/artifacts/report-1/content',
      },
    },
    { kind: 'text', text: 'End of report' },
  ]);
});

test('legacy text and attachments remain a deterministic fallback', () => {
  assert.deepEqual(normalizeMessageParts(undefined, 'Hello', [
    { type: 'image', path: 'image-1', filename: 'chart.png' },
  ]), [
    { kind: 'text', text: 'Hello' },
    { kind: 'attachment', attachment: { type: 'image', path: 'image-1', filename: 'chart.png' } },
  ]);
});

test('inline view parts require an immutable positive revision', () => {
  assert.deepEqual(normalizeMessageParts([
    { kind: 'ui_view', view_id: 'latest-is-not-allowed', revision: 0 },
    { kind: 'ui_view', view_id: 'missing-revision' },
  ], 'Safe fallback'), [{ kind: 'text', text: 'Safe fallback' }]);
});

test('early additive artifacts do not hide legacy response text', () => {
  assert.deepEqual(normalizeMessageContent(undefined, [
    { type: 'ui_view', viewId: 'view-2', revision: 1 },
  ], 'Dashboard follows'), [
    { kind: 'text', text: 'Dashboard follows' },
    { kind: 'ui_view', view_id: 'view-2', revision: 1 },
  ]);
});
