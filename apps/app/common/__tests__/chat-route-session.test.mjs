import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: { contents: `export { resolveChatRouteSession } from './common/chat-route-session';`, resolveDir: root },
});
const { resolveChatRouteSession } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const base = { routeSession: undefined, appliedRouteSession: null, destination: null, staleRouteSession: null, activeSessionId: null };

test('a cold deep link activates the routed conversation', () => {
  const d = resolveChatRouteSession({ ...base, routeSession: 'a', activeSessionId: 'x' });
  assert.equal(d.activate, 'a');
  assert.equal(d.appliedRouteSession, 'a');
});

test('an in-app selection wins over a route that kept the previous draft', () => {
  const d = resolveChatRouteSession({ ...base, routeSession: 'draft', destination: 'chosen', activeSessionId: 'chosen' });
  assert.equal(d.activate, null);
  assert.equal(d.consumeDestination, true);
  assert.equal(d.staleRouteSession, 'draft');
});

test('returning to Chat does not resurrect the stale draft parameter', () => {
  // Chat remounts (fresh applied marker) with the dropped-param route still naming the draft.
  const d = resolveChatRouteSession({ ...base, routeSession: 'draft', staleRouteSession: 'draft', activeSessionId: 'chosen' });
  assert.equal(d.activate, null);
});

test('a later genuine deep link to another conversation is still applied', () => {
  const d = resolveChatRouteSession({ ...base, routeSession: 'linked', staleRouteSession: 'draft', activeSessionId: 'chosen' });
  assert.equal(d.activate, 'linked');
});

test('a destination different from the active session activates it', () => {
  const d = resolveChatRouteSession({ ...base, routeSession: 'old', destination: 'new', activeSessionId: 'old' });
  assert.equal(d.activate, 'new');
});
