import assert from 'node:assert/strict';
import test from 'node:test';

import { persistAccountAdditionWhileCurrent } from '../guarded-account-persistence.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('stale join during storage write keeps consumed membership and concurrent additions', async () => {
  const firstWrite = deferred();
  let current = true;
  let zustandAccounts = [{ id: 'existing-a' }];
  let persistedPayload = JSON.stringify(zustandAccounts);
  let writeCount = 0;

  const join = persistAccountAdditionWhileCurrent({
    account: { id: 'stale-join' },
    isCurrent: () => current,
    readAccounts: () => zustandAccounts,
    commitAccounts: (accounts) => { zustandAccounts = accounts; },
    persistAccounts: async (accounts) => {
      writeCount += 1;
      if (writeCount === 1) await firstWrite.promise;
      persistedPayload = JSON.stringify(accounts);
    },
  });

  // A newer action lands while the stale join's first storage write is
  // suspended. Rollback must retain it by reading current memory.
  current = false;
  zustandAccounts = [...zustandAccounts, { id: 'newer-b' }];
  firstWrite.resolve();

  assert.equal(await join, false);
  assert.deepEqual(
    zustandAccounts,
    [{ id: 'existing-a' }, { id: 'stale-join' }, { id: 'newer-b' }],
  );
  assert.deepEqual(
    JSON.parse(persistedPayload),
    [{ id: 'existing-a' }, { id: 'stale-join' }, { id: 'newer-b' }],
  );
  assert.equal(writeCount, 2);
});

test('already-stale successful join is still persisted for explicit reconnect', async () => {
  let accounts = [{ id: 'existing' }];
  let persisted = '[]';
  const current = await persistAccountAdditionWhileCurrent({
    account: { id: 'consumed-invite' },
    isCurrent: () => false,
    readAccounts: () => accounts,
    commitAccounts: (next) => { accounts = next; },
    persistAccounts: async (next) => { persisted = JSON.stringify(next); },
  });

  assert.equal(current, false);
  assert.deepEqual(accounts, [{ id: 'existing' }, { id: 'consumed-invite' }]);
  assert.deepEqual(JSON.parse(persisted), accounts);
});

test('current join commits once without compensation', async () => {
  let zustandAccounts = [];
  let persistedPayload = '[]';
  let writeCount = 0;

  const committed = await persistAccountAdditionWhileCurrent({
    account: { id: 'joined' },
    isCurrent: () => true,
    readAccounts: () => zustandAccounts,
    commitAccounts: (accounts) => { zustandAccounts = accounts; },
    persistAccounts: async (accounts) => {
      writeCount += 1;
      persistedPayload = JSON.stringify(accounts);
    },
  });

  assert.equal(committed, true);
  assert.deepEqual(zustandAccounts, [{ id: 'joined' }]);
  assert.deepEqual(JSON.parse(persistedPayload), [{ id: 'joined' }]);
  assert.equal(writeCount, 1);
});
