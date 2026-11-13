import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordUpdaterEvent } from '../../../dist/update-policy.js';

test('updater events reach a persistent log a packaged app can be diagnosed from', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-updater-log-'));
  const logs = path.join(dir, 'nested', 'logs');
  recordUpdaterEvent(logs, 'available', '1.1.0-beta.42');
  recordUpdaterEvent(logs, 'error', 'net::ERR_CONNECTION_RESET\n  at download');
  const lines = fs.readFileSync(path.join(logs, 'updater.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.* available 1\.1\.0-beta\.42$/);
  assert.match(lines[1], / error net::ERR_CONNECTION_RESET at download$/);
});

test('logging never throws when the log directory cannot be written', () => {
  assert.doesNotThrow(() => recordUpdaterEvent('/dev/null/not-a-dir', 'error', 'x'));
});
