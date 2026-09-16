import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DEV_SERVER_PORT,
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  PRODUCTION_CSP,
  resolveDevServerUrl,
} from '../../../dist/security-policy.js';

test('development renderer URL only accepts a numeric TCP port', () => {
  assert.equal(DEFAULT_DEV_SERVER_PORT, 8081);
  assert.equal(resolveDevServerUrl(undefined), 'http://localhost:8081');
  assert.equal(resolveDevServerUrl('1'), 'http://localhost:1');
  assert.equal(resolveDevServerUrl('49152'), 'http://localhost:49152');
  assert.equal(resolveDevServerUrl('65535'), 'http://localhost:65535');

  for (const value of [
    '',
    '0',
    '65536',
    '-1',
    '+8082',
    ' 8082',
    '8082 ',
    '8e3',
    '8082/path',
    '8082@evil.example',
    'http://evil.example:8082',
  ]) {
    assert.throws(
      () => resolveDevServerUrl(value),
      /OPENAGENT_DEV_SERVER_PORT must be an integer between 1 and 65535/,
    );
  }
});

test('renderer navigation stays on the app origin', () => {
  const origin = 'http://127.0.0.1:43123';
  assert.equal(isAllowedRendererNavigation(`${origin}/views/abc?x=1`, origin), true);
  assert.equal(isAllowedRendererNavigation('https://example.com/phish', origin), false);
  assert.equal(isAllowedRendererNavigation('javascript:alert(1)', origin), false);
});

test('external URL allowlist rejects executable and privileged schemes', () => {
  assert.equal(isAllowedExternalUrl('https://openagent.uno/docs'), true);
  assert.equal(isAllowedExternalUrl('mailto:hello@openagent.uno'), true);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl('openagent://ticket'), false);
  assert.equal(isAllowedExternalUrl('https://user:secret@example.com/private'), false);
  assert.equal(isAllowedExternalUrl('https://example.com/\u0000bad'), false);
});

test('production CSP disables eval, objects and framing', () => {
  assert.match(PRODUCTION_CSP, /object-src 'none'/);
  assert.match(PRODUCTION_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(PRODUCTION_CSP, /unsafe-eval/);
  assert.doesNotMatch(PRODUCTION_CSP, /img-src[^;]*https:/);
});
