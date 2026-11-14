import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  entryPoints: [root + '/common/markdown-inline.ts'],
});
const { inlineMarkdownPattern } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const emphasis = (text) => [...text.matchAll(inlineMarkdownPattern())]
  .filter((m) => m[9] || m[12])
  .map((m) => [m[9] || m[12], m[10] || m[13]]);

test('underscores inside words are never emphasis', () => {
  assert.deepEqual(emphasis('Bearer ${secret:OPENAGENT_MCP_SECRET_BUZZ_STAFF_TOKEN}'), []);
  assert.deepEqual(emphasis('call forum_activity and dashboard_tickets_GetQueue'), []);
  assert.deepEqual(emphasis('snake_case_name and my__init__value'), []);
});

test('underscore emphasis still works at word boundaries', () => {
  assert.deepEqual(emphasis('this is _important_ and __strong__.'), [['_', 'important'], ['__', 'strong']]);
  assert.deepEqual(emphasis('(_quoted_)'), [['_', 'quoted']]);
});

test('asterisk emphasis and strike are unchanged', () => {
  assert.deepEqual(emphasis('**bold** and *it* and ~~gone~~'), [['**', 'bold'], ['*', 'it'], ['~~', 'gone']]);
});

test('the other inline tokens keep their groups', () => {
  const m = [...'`a_b_c` [x](https://e.x/a_b_c) $a_b$'.matchAll(inlineMarkdownPattern())];
  assert.equal(m[0][3], 'a_b_c');
  assert.equal(m[1][6], 'x');
  assert.equal(m[2][11], 'a_b');
});
