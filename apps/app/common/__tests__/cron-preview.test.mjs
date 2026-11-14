import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  entryPoints: [root + '/common/cron-preview.ts'],
});
const { cronDescribeQuery, previewZoneLabel } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('the preview asks for the task timezone', () => {
  const q = new URLSearchParams(cronDescribeQuery('0 9 * * *', 3, 'Asia/Dubai'));
  assert.equal(q.get('expression'), '0 9 * * *');
  assert.equal(q.get('count'), '3');
  assert.equal(q.get('timezone'), 'Asia/Dubai');
});

test('without a timezone the query omits it and the label says UTC', () => {
  const q = new URLSearchParams(cronDescribeQuery('0 9 * * *', 3, null));
  assert.equal(q.has('timezone'), false);
  assert.equal(previewZoneLabel(undefined, null), 'UTC');
  assert.equal(previewZoneLabel('Asia/Dubai', null), 'Asia/Dubai');
});
