import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRendererTarget,
  createRendererUrlPolicy,
  isTrustedRendererUrl,
  safeExternalHttpUrl,
} from '../../../dist/security/renderer-url-policy.js';
import {
  isPathContained,
  resolveStaticFile,
} from '../../../dist/security/static-file-policy.js';
import {
  UntrustedRendererError,
  assertTrustedMainFrame,
  clearTrustedRenderersForTests,
  isTrustedRenderer,
  registerTrustedRenderer,
  sendToTrustedRenderer,
} from '../../../dist/security/trusted-renderers.js';

test('renderer URL policy pins one loopback origin and constructs only relative routes', () => {
  const policy = createRendererUrlPolicy('http://127.0.0.1:43123/ignored');
  assert.equal(policy.origin, 'http://127.0.0.1:43123');
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:43123/settings?x=1#tab', policy), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:43124/settings', policy), false);
  assert.equal(isTrustedRendererUrl('http://localhost:43123/settings', policy), false);
  assert.equal(isTrustedRendererUrl('https://127.0.0.1:43123/settings', policy), false);
  assert.equal(isTrustedRendererUrl('data:text/html,owned', policy), false);
  assert.equal(isTrustedRendererUrl('http://user@127.0.0.1:43123/', policy), false);

  assert.equal(
    buildRendererTarget(policy, 'terminal/id?cwd=%2Ftmp').href,
    'http://127.0.0.1:43123/terminal/id?cwd=%2Ftmp',
  );
  for (const route of ['//evil.example/x', '/absolute', 'https://evil.example/', '..\\evil']) {
    assert.throws(() => buildRendererTarget(policy, route), /relative same-origin route|escaped/);
  }

  for (const invalid of [
    'https://127.0.0.1:43123',
    'http://example.com:43123',
    'http://127.0.0.1',
    'http://user@127.0.0.1:43123',
  ]) assert.throws(() => createRendererUrlPolicy(invalid), /loopback http origin/);
});

test('external URL policy canonicalizes http(s) and rejects command-capable schemes', () => {
  assert.equal(safeExternalHttpUrl('https://openagent.uno/docs?q=1'), 'https://openagent.uno/docs?q=1');
  assert.equal(safeExternalHttpUrl('http://example.test/a'), 'http://example.test/a');
  for (const raw of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,owned',
    'openagent://join/secret',
    'https://user:password@example.test/',
    'not a url',
  ]) assert.equal(safeExternalHttpUrl(raw), null);
});

test('trusted renderer registry enforces navigation, redirects, webview denial and exact main-frame IPC', async () => {
  clearTrustedRenderersForTests();
  const contents = new FakeWebContents(41, 'http://127.0.0.1:41001/chat');
  const win = new FakeBrowserWindow(contents);
  const opened = [];
  const policy = createRendererUrlPolicy('http://127.0.0.1:41001');
  registerTrustedRenderer(win, policy, async (url) => { opened.push(url); });

  const sameOriginNavigation = preventableEvent();
  contents.emit('will-navigate', sameOriginNavigation, 'http://127.0.0.1:41001/settings');
  assert.equal(sameOriginNavigation.prevented, false);

  const crossOriginNavigation = preventableEvent();
  contents.emit('will-navigate', crossOriginNavigation, 'https://evil.example/');
  assert.equal(crossOriginNavigation.prevented, true);

  const crossOriginRedirect = preventableEvent();
  contents.emit('will-redirect', crossOriginRedirect, 'http://127.0.0.1:41002/owned');
  assert.equal(crossOriginRedirect.prevented, true);

  const webviewAttach = preventableEvent();
  const webPreferences = { preload: '/tmp/evil.js', nodeIntegration: true, contextIsolation: false };
  contents.emit('will-attach-webview', webviewAttach, webPreferences, {});
  assert.equal(webviewAttach.prevented, true);
  assert.deepEqual(webPreferences, {
    preload: undefined,
    nodeIntegration: false,
    contextIsolation: true,
  });

  assert.deepEqual(contents.openWindow('file:///etc/passwd'), { action: 'deny' });
  assert.deepEqual(contents.openWindow('https://openagent.uno/help'), { action: 'deny' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ['https://openagent.uno/help']);

  const trustedEvent = { sender: contents, senderFrame: contents.mainFrame };
  assert.doesNotThrow(() => assertTrustedMainFrame(trustedEvent));
  assert.equal(isTrustedRenderer(contents), true);
  assert.equal(sendToTrustedRenderer(contents, 'safe:status', { ok: true }), true);
  assert.deepEqual(contents.sent, [['safe:status', { ok: true }]]);

  assert.throws(
    () => assertTrustedMainFrame({ sender: contents, senderFrame: { url: contents.mainFrame.url } }),
    UntrustedRendererError,
  );
  const unregistered = new FakeWebContents(42, contents.mainFrame.url);
  assert.throws(
    () => assertTrustedMainFrame({ sender: unregistered, senderFrame: unregistered.mainFrame }),
    UntrustedRendererError,
  );

  contents.mainFrame.url = 'https://evil.example/';
  assert.equal(sendToTrustedRenderer(contents, 'secret', 'must-not-leak'), false);
  assert.equal(contents.sent.length, 1);
  contents.emit('did-navigate', {}, contents.mainFrame.url);
  assert.equal(win.destroyed, true);
  assert.throws(() => assertTrustedMainFrame(trustedEvent), UntrustedRendererError);
  clearTrustedRenderersForTests();
});

test('trusted renderer registry rejects a reused WebContents id and revokes destroyed contents', () => {
  clearTrustedRenderersForTests();
  const policy = createRendererUrlPolicy('http://localhost:8081');
  const first = new FakeWebContents(9, 'http://localhost:8081/');
  registerTrustedRenderer(new FakeBrowserWindow(first), policy, () => {});
  const impostor = new FakeWebContents(9, 'http://localhost:8081/');
  assert.throws(
    () => registerTrustedRenderer(new FakeBrowserWindow(impostor), policy, () => {}),
    /different WebContents/,
  );
  first.destroyed = true;
  first.emit('destroyed');
  assert.equal(isTrustedRenderer(first), false);
  clearTrustedRenderersForTests();
});

test('static path resolver rejects traversal, sibling prefixes and escaping symlinks', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openagent-renderer-security-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'web');
  const sibling = path.join(temporary, 'web-secret');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(sibling);
  await writeFile(path.join(root, 'index.html'), '<main>trusted</main>');
  await writeFile(path.join(root, 'assets', 'app.js'), 'trusted();');
  await writeFile(path.join(sibling, 'secret.txt'), 'never serve me');
  const realRoot = await realpath(root);

  assert.equal(isPathContained(root, path.join(root, 'assets', 'app.js')), true);
  assert.equal(isPathContained(root, sibling), false, 'sibling-prefix path must not pass');
  assert.deepEqual(resolveStaticFile(root, '/assets/app.js'), {
    kind: 'file', path: path.join(realRoot, 'assets', 'app.js'),
  });
  assert.deepEqual(resolveStaticFile(root, '/settings/deep-link'), {
    kind: 'file', path: path.join(realRoot, 'index.html'),
  });
  assert.deepEqual(resolveStaticFile(root, '/assets/missing.js'), { kind: 'not_found' });
  assert.deepEqual(resolveStaticFile(root, '/../web-secret/secret.txt'), { kind: 'forbidden' });
  assert.deepEqual(resolveStaticFile(root, '/..\\web-secret\\secret.txt'), { kind: 'forbidden' });

  await symlink(path.join(sibling, 'secret.txt'), path.join(root, 'escape.txt'));
  assert.deepEqual(resolveStaticFile(root, '/escape.txt'), { kind: 'forbidden' });

  await symlink(path.join(root, 'assets', 'app.js'), path.join(root, 'inside.js'));
  assert.deepEqual(resolveStaticFile(root, '/inside.js'), {
    kind: 'file', path: path.join(realRoot, 'assets', 'app.js'),
  });
});

test('static SPA fallback cannot follow an escaping index symlink', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openagent-index-symlink-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'web');
  await mkdir(root);
  const outside = path.join(temporary, 'outside.html');
  await writeFile(outside, 'outside');
  await symlink(outside, path.join(root, 'index.html'));
  assert.deepEqual(resolveStaticFile(root, '/settings'), { kind: 'forbidden' });
});

class FakeWebContents extends EventEmitter {
  constructor(id, url) {
    super();
    this.id = id;
    this.mainFrame = { url };
    this.destroyed = false;
    this.sent = [];
    this.windowOpenHandler = null;
  }

  isDestroyed() { return this.destroyed; }
  send(channel, ...args) { this.sent.push([channel, ...args]); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  openWindow(url) { return this.windowOpenHandler({ url }); }
}

class FakeBrowserWindow {
  constructor(contents) {
    this.webContents = contents;
    this.destroyed = false;
  }

  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.webContents.destroyed = true; }
}

function preventableEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}
