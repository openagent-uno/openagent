import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountStartCoordinator } from '../../../dist/services/account-start-coordinator.js';
import { createCredentialPreferenceCoordinator } from '../../../dist/services/credentials-core.js';

test('concurrent account starts persist only the credential that owned authentication', async () => {
  const coordinator = createAccountStartCoordinator();
  let resolveStart;
  const gate = new Promise((resolve) => { resolveStart = resolve; });
  let starts = 0;
  const persisted = [];

  const first = coordinator.run(
    'account-1',
    async () => {
      starts += 1;
      await gate;
      return 4242;
    },
    () => { persisted.push('authenticated-password'); },
  );
  const waiter = coordinator.run(
    'account-1',
    async () => {
      starts += 1;
      return 9999;
    },
    () => { persisted.push('unverified-waiter-password'); },
  );

  resolveStart();
  assert.deepEqual(await Promise.all([first, waiter]), [4242, 4242]);
  assert.equal(starts, 1);
  assert.deepEqual(persisted, ['authenticated-password']);

  // A settled flight is removed, so a later explicit attempt can own a new
  // authentication and persist its independently verified credential.
  const later = await coordinator.run(
    'account-1',
    async () => 5151,
    () => { persisted.push('later-verified-password'); },
  );
  assert.equal(later, 5151);
  assert.deepEqual(persisted, ['authenticated-password', 'later-verified-password']);
});

test('a later multi-window preference prevents an older owner from restoring a secret', async () => {
  const coordinator = createAccountStartCoordinator();
  const preferences = createCredentialPreferenceCoordinator();
  let resolveStart;
  const gate = new Promise((resolve) => { resolveStart = resolve; });
  const persisted = [];

  const ownerPreference = preferences.begin('account-1', true);
  const owner = coordinator.run(
    'account-1',
    async () => {
      await gate;
      return 4242;
    },
    () => {
      if (ownerPreference.shouldSaveAuthenticatedOwner()) persisted.push('owner-password');
    },
  );

  const laterRememberOff = preferences.begin('account-1', false);
  assert.equal(laterRememberOff.forgetImmediately, true);
  const waiter = coordinator.run(
    'account-1',
    async () => 9999,
    () => { persisted.push('unverified-waiter-password'); },
  );

  resolveStart();
  assert.deepEqual(await Promise.all([owner, waiter]), [4242, 4242]);
  assert.deepEqual(persisted, []);
});
