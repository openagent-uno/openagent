/**
 * OS-backed remembered credentials.
 *
 * Ciphertext is persisted in the Electron userData directory, while the key
 * is owned by macOS Keychain, Windows DPAPI, or a real Linux secret store via
 * Electron safeStorage. Linux's `basic_text` fallback is deliberately
 * rejected: remember-me becomes unavailable instead of storing plaintext.
 */

import * as fs from 'node:fs';
import { safeStorage } from 'electron';
import Store from 'electron-store';
import { handleTrustedIpc } from '../security/trusted-ipc';
import {
  createCredentialVault,
  isSafeStorageBackendUsable,
  type CredentialBackend,
  type CredentialCipher,
  type RememberedCredentialRecord,
  type RememberedCredentialTarget,
} from './credentials-core';

let encryptedStore: Store<Record<string, string>> | null = null;

function getEncryptedStore(): Store<Record<string, string>> {
  if (encryptedStore == null) {
    encryptedStore = new Store<Record<string, string>>({ name: 'openagent-credentials' });
  }
  return encryptedStore;
}

const backend: CredentialBackend = {
  get: (accountId) => {
    const store = getEncryptedStore();
    return store.has(accountId) ? store.get(accountId) ?? null : null;
  },
  set: (accountId, value) => {
    const store = getEncryptedStore();
    store.set(accountId, value);
    try { fs.chmodSync(store.path, 0o600); } catch { /* best effort on non-POSIX */ }
  },
  delete: (accountId) => {
    getEncryptedStore().delete(accountId);
  },
};

const cipher: CredentialCipher = {
  isAvailable: () => {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    const selected = process.platform === 'linux'
      ? safeStorage.getSelectedStorageBackend()
      : undefined;
    return isSafeStorageBackendUsable(process.platform, encryptionAvailable, selected);
  },
  encrypt: (plainText) => safeStorage.encryptString(plainText),
  decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText)),
};

const vault = createCredentialVault(backend, cipher);

export function rememberedCredentialsAvailable(): boolean {
  return vault.isAvailable();
}

export function loadRememberedCredential(accountId: string): RememberedCredentialRecord | null {
  return vault.load(accountId);
}

export function saveRememberedCredential(
  accountId: string,
  password: string,
  target: RememberedCredentialTarget,
): boolean {
  return vault.save(accountId, password, target);
}

export function removeRememberedCredential(accountId: string): void {
  vault.remove(accountId);
}

export function registerCredentialHandlers(): void {
  handleTrustedIpc('credentials:isAvailable', () => rememberedCredentialsAvailable());
  handleTrustedIpc('credentials:remove', (_event, accountId: unknown) => {
    if (typeof accountId !== 'string') {
      throw new Error('credentials:remove requires accountId');
    }
    removeRememberedCredential(accountId);
  });
}
