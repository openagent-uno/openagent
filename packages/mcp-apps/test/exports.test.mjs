import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

test('public browser operator resolves for CommonJS desktop bundlers', async () => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@openagent/mcp-apps/browser-operator');
  assert(entry.endsWith('/src/browser-operator.mjs'));
  const module = await import('@openagent/mcp-apps/browser-operator');
  assert.equal(typeof module.performBrowserDecision, 'function');
});
