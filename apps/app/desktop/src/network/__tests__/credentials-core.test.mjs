import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCredentialVault,
  createCredentialPreferenceCoordinator,
  isSafeStorageBackendUsable,
  isCredentialRejection,
  isRememberedCredentialTargetRejection,
  publicRememberedCredentialTarget,
  rememberedCredentialMatchesRequest,
} from '../../../dist/services/credentials-core.js';

function target(overrides = {}) {
  return {
    accountId: 'account-1',
    networkName: 'HomeLab',
    networkId: 'network-123',
    handle: 'Alice',
    coordinatorNodeId: 'Coordinator-ABC',
    agentHandle: 'My-Agent',
    agentNodeId: 'Agent-XYZ',
    ...overrides,
  };
}

function fixture({ available = true } = {}) {
  const values = new Map();
  const backend = {
    get: (id) => values.get(id) ?? null,
    set: (id, value) => values.set(id, value),
    delete: (id) => values.delete(id),
  };
  const cipher = {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decrypt: (value) => {
      const decoded = Buffer.from(value).toString('utf8');
      if (!decoded.startsWith('sealed:')) throw new Error('corrupt');
      return decoded.slice('sealed:'.length);
    },
  };
  return { values, vault: createCredentialVault(backend, cipher) };
}

test('credential vault persists ciphertext and round-trips through the cipher', () => {
  const { values, vault } = fixture();
  assert.equal(vault.save('account-1', 'correct horse battery staple', target()), true);
  const persisted = values.get('account-1');
  assert.ok(persisted);
  assert.doesNotMatch(persisted, /correct horse battery staple/);
  assert.equal(vault.has('account-1'), true);
  assert.deepEqual(vault.load('account-1'), {
    version: 1,
    password: 'correct horse battery staple',
    target: {
      accountId: 'account-1',
      networkName: 'homelab',
      networkId: 'network-123',
      handle: 'alice',
      coordinatorNodeId: 'coordinator-abc',
      agentHandle: 'my-agent',
      agentNodeId: 'agent-xyz',
    },
  });
  vault.remove('account-1');
  assert.equal(vault.has('account-1'), false);
});

test('credential vault has no plaintext fallback when secure storage is unavailable', () => {
  const { values, vault } = fixture({ available: false });
  assert.equal(vault.isAvailable(), false);
  assert.equal(vault.save('account-1', 'do-not-store', target()), false);
  assert.equal(values.size, 0);
  assert.equal(vault.load('account-1'), null);
});

test('Linux basic_text and unknown safeStorage backends are rejected', () => {
  assert.equal(isSafeStorageBackendUsable('linux', true, 'basic_text'), false);
  assert.equal(isSafeStorageBackendUsable('linux', true, 'unknown'), false);
  assert.equal(isSafeStorageBackendUsable('linux', true, undefined), false);
  assert.equal(isSafeStorageBackendUsable('linux', true, 'gnome_libsecret'), true);
  assert.equal(isSafeStorageBackendUsable('darwin', true), true);
  assert.equal(isSafeStorageBackendUsable('win32', false), false);
});

test('credential vault removes corrupt entries and validates IPC identifiers', () => {
  const { values, vault } = fixture();
  values.set('account-1', Buffer.from('not-a-sealed-value').toString('base64'));
  assert.equal(vault.load('account-1'), null);
  assert.equal(values.has('account-1'), false);
  assert.throws(() => vault.save('../escape', 'secret', target()), /accountId is invalid/);
  assert.throws(() => vault.save('account-1', '', target()), /password must be between/);
  assert.throws(
    () => vault.save('account-1', 'secret', target({ accountId: 'account-2' })),
    /does not match storage key/,
  );
});

test('legacy password-only ciphertext fails closed and is removed', () => {
  const { values, vault } = fixture();
  values.set(
    'account-1',
    Buffer.from('sealed:legacy-plaintext-record', 'utf8').toString('base64'),
  );

  assert.equal(vault.load('account-1'), null);
  assert.equal(values.has('account-1'), false);
});

test('remembered targets reject renderer mismatch, tickets, and cross-account replay', () => {
  const { values, vault } = fixture();
  assert.equal(vault.save('account-1', 'secret', target()), true);
  const record = vault.load('account-1');
  assert.ok(record);

  assert.equal(rememberedCredentialMatchesRequest(record, {
    accountId: 'account-1',
    network: 'HOMELAB',
    handle: 'Alice',
  }), true);
  assert.equal(rememberedCredentialMatchesRequest(record, {
    accountId: 'account-1',
    network: '',
    handle: 'pre-auth-placeholder',
  }), true, 'a crash placeholder may leave network unspecified');
  assert.equal(rememberedCredentialMatchesRequest(record, {
    accountId: 'account-1',
  }), true, 'main-only recovery uses the encrypted target when metadata is absent');
  assert.equal(rememberedCredentialMatchesRequest(record, {
    accountId: 'account-1',
    network: 'attacker-network',
    handle: 'alice',
  }), false);
  assert.equal(rememberedCredentialMatchesRequest(record, {
    accountId: 'account-1',
    network: 'homelab',
    handle: 'mallory',
  }), false);
  assert.equal(rememberedCredentialMatchesRequest(record, {
    accountId: 'account-1',
    network: 'homelab',
    handle: 'alice',
    agent: 'attacker-agent',
  }), false);
  assert.equal(rememberedCredentialMatchesRequest(record, {
    accountId: 'account-1',
    ticket: 'oa1attacker',
  }), false);
  assert.deepEqual(publicRememberedCredentialTarget(record.target), {
    network: 'homelab',
    handle: 'alice',
    agentHandle: 'my-agent',
  });

  // Moving a valid ciphertext under another account key cannot replay it.
  values.set('account-2', values.get('account-1'));
  assert.equal(vault.load('account-2'), null);
  assert.equal(values.has('account-2'), false);
});

test('remember preference forgets on reuse but saves only for an authenticated owner', () => {
  const preferences = createCredentialPreferenceCoordinator();

  const reusedWithRememberOff = preferences.begin('account-1', false);
  assert.equal(reusedWithRememberOff.forgetImmediately, true);
  assert.equal(reusedWithRememberOff.shouldSaveAuthenticatedOwner(), false);

  const authenticatedOwner = preferences.begin('account-2', true);
  assert.equal(authenticatedOwner.forgetImmediately, false);
  assert.equal(authenticatedOwner.shouldSaveAuthenticatedOwner(), true);

  const unverifiedWaiter = preferences.begin('account-2', true);
  assert.equal(
    authenticatedOwner.shouldSaveAuthenticatedOwner(),
    false,
    'an older owner must not save after a newer unverified preference arrives',
  );
  assert.equal(unverifiedWaiter.shouldSaveAuthenticatedOwner(), true);

  const rememberOffWaiter = preferences.begin('account-2', false);
  assert.equal(rememberOffWaiter.forgetImmediately, true);
  assert.equal(unverifiedWaiter.shouldSaveAuthenticatedOwner(), false);
});

test('only authentication rejection invalidates a remembered credential', () => {
  assert.equal(isCredentialRejection(new Error('login_finish failed: unauthorized')), true);
  assert.equal(isCredentialRejection(new Error('invalid_credentials')), true);
  assert.equal(isCredentialRejection(new Error('coordinator unreachable: timed out')), false);
  assert.equal(isCredentialRejection(new Error('connection refused')), false);
  assert.equal(
    isRememberedCredentialTargetRejection(
      new Error('remembered credential target no longer matches this network'),
    ),
    true,
  );
  assert.equal(isRememberedCredentialTargetRejection(new Error('connection refused')), false);
});
