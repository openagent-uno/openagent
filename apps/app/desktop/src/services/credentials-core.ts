/** Pure encrypted-credential vault primitives, isolated for unit testing. */

export interface CredentialCipher {
  isAvailable(): boolean;
  encrypt(plainText: string): Uint8Array;
  decrypt(cipherText: Uint8Array): string;
}

export interface CredentialBackend {
  get(accountId: string): string | null;
  set(accountId: string, cipherTextBase64: string): void;
  delete(accountId: string): void;
}

export interface RememberedCredentialTarget {
  accountId: string;
  networkName: string;
  networkId: string;
  handle: string;
  coordinatorNodeId: string;
  agentHandle: string;
  agentNodeId: string;
}

export interface RememberedCredentialRecord {
  version: 1;
  password: string;
  target: RememberedCredentialTarget;
}

export interface RememberedCredentialRequest {
  accountId: string;
  network?: string;
  handle?: string;
  agent?: string;
  ticket?: string;
}

export interface PublicRememberedCredentialTarget {
  network: string;
  handle: string;
  agentHandle: string;
}

export interface CredentialVault {
  isAvailable(): boolean;
  has(accountId: string): boolean;
  load(accountId: string): RememberedCredentialRecord | null;
  save(
    accountId: string,
    password: string,
    target: RememberedCredentialTarget,
  ): boolean;
  remove(accountId: string): void;
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PASSWORD_LENGTH = 4096;
const MAX_TARGET_FIELD_LENGTH = 1024;

export function isSafeStorageBackendUsable(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
  selectedBackend?: string,
): boolean {
  if (!encryptionAvailable) return false;
  if (platform !== 'linux') return true;
  return !!selectedBackend
    && selectedBackend !== 'basic_text'
    && selectedBackend !== 'unknown';
}

function assertAccountId(accountId: string): void {
  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error('credential accountId is invalid');
  }
}

function assertPassword(password: string): void {
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('credential password must be between 1 and 4096 characters');
  }
}

function normalizeTargetField(value: string, field: string): string {
  if (typeof value !== 'string') throw new Error(`credential ${field} is invalid`);
  const normalized = value.trim().toLowerCase();
  if (
    !normalized || normalized.length > MAX_TARGET_FIELD_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`credential ${field} is invalid`);
  }
  return normalized;
}

export function normalizeRememberedCredentialTarget(
  target: RememberedCredentialTarget,
): RememberedCredentialTarget {
  assertAccountId(target.accountId);
  return {
    accountId: target.accountId,
    networkName: normalizeTargetField(target.networkName, 'networkName'),
    networkId: normalizeTargetField(target.networkId, 'networkId'),
    handle: normalizeTargetField(target.handle, 'handle'),
    coordinatorNodeId: normalizeTargetField(target.coordinatorNodeId, 'coordinatorNodeId'),
    agentHandle: normalizeTargetField(target.agentHandle, 'agentHandle'),
    agentNodeId: normalizeTargetField(target.agentNodeId, 'agentNodeId'),
  };
}

/**
 * The renderer may identify the saved row, but it never chooses the target
 * used with the decrypted password. A ticket is categorically unsupported;
 * explicit metadata must match the encrypted, authenticated target.
 */
export function rememberedCredentialMatchesRequest(
  record: RememberedCredentialRecord,
  request: RememberedCredentialRequest,
): boolean {
  try {
    if (request.ticket !== undefined) return false;
    assertAccountId(request.accountId);
    if (request.accountId !== record.target.accountId) return false;
    // Empty/missing renderer metadata is an allowed crash placeholder. Main
    // still starts exclusively from the encrypted target below; supplied
    // non-empty values are assertions and must match.
    if (request.handle !== undefined && typeof request.handle !== 'string') return false;
    if (request.network !== undefined && typeof request.network !== 'string') return false;
    if (request.agent !== undefined && typeof request.agent !== 'string') return false;
    if (request.network === undefined || request.network.trim() === '') {
      return true;
    }
    if (
      typeof request.handle === 'string' && request.handle.trim() &&
      normalizeTargetField(request.handle, 'handle') !== record.target.handle
    ) return false;
    const network = normalizeTargetField(request.network, 'network');
    if (network !== record.target.networkName && network !== record.target.networkId) return false;
    if (
      typeof request.agent === 'string' && request.agent.trim() &&
      normalizeTargetField(request.agent, 'agent') !== record.target.agentHandle
    ) return false;
    return true;
  } catch {
    return false;
  }
}

export function publicRememberedCredentialTarget(
  target: RememberedCredentialTarget,
): PublicRememberedCredentialTarget {
  const normalized = normalizeRememberedCredentialTarget(target);
  return {
    network: normalized.networkName,
    handle: normalized.handle,
    agentHandle: normalized.agentHandle,
  };
}

export interface CredentialPreferenceLease {
  forgetImmediately: boolean;
  shouldSaveAuthenticatedOwner(): boolean;
}

/**
 * Orders remember preferences independently from the account start
 * single-flight. A later waiter (including Remember off) invalidates an
 * older owner's pending save; a waiter with Remember on still cannot save
 * because its password was not the one authenticated by the owner.
 */
export function createCredentialPreferenceCoordinator() {
  const generations = new Map<string, number>();

  return {
    begin(
      accountId: string,
      remember: boolean | undefined,
    ): CredentialPreferenceLease {
      const previous = generations.get(accountId) ?? 0;
      const generation = remember === undefined ? previous : previous + 1;
      if (remember !== undefined) generations.set(accountId, generation);
      return {
        forgetImmediately: remember === false,
        shouldSaveAuthenticatedOwner() {
          return remember === true && generations.get(accountId) === generation;
        },
      };
    },
  };
}

function parseRecord(accountId: string, plainText: string): RememberedCredentialRecord {
  const raw = JSON.parse(plainText) as Partial<RememberedCredentialRecord> | null;
  if (!raw || raw.version !== 1 || typeof raw.password !== 'string' || !raw.target) {
    throw new Error('credential record schema is invalid');
  }
  assertPassword(raw.password);
  const target = normalizeRememberedCredentialTarget(
    raw.target as RememberedCredentialTarget,
  );
  if (target.accountId !== accountId) throw new Error('credential record account mismatch');
  return { version: 1, password: raw.password, target };
}

export function createCredentialVault(
  backend: CredentialBackend,
  cipher: CredentialCipher,
): CredentialVault {
  const available = () => {
    try {
      return cipher.isAvailable();
    } catch {
      return false;
    }
  };

  return {
    isAvailable: available,

    has(accountId) {
      assertAccountId(accountId);
      return available() && backend.get(accountId) != null;
    },

    load(accountId) {
      assertAccountId(accountId);
      if (!available()) return null;
      const encoded = backend.get(accountId);
      if (encoded == null) return null;
      try {
        const encrypted = Buffer.from(encoded, 'base64');
        if (encrypted.length === 0) throw new Error('empty ciphertext');
        return parseRecord(accountId, cipher.decrypt(encrypted));
      } catch {
        // A corrupted or no-longer-decryptable entry must never trap the app
        // in an automatic-login loop. Remove only this account's ciphertext.
        backend.delete(accountId);
        return null;
      }
    },

    save(accountId, password, target) {
      assertAccountId(accountId);
      assertPassword(password);
      const normalizedTarget = normalizeRememberedCredentialTarget(target);
      if (normalizedTarget.accountId !== accountId) {
        throw new Error('credential target accountId does not match storage key');
      }
      if (!available()) return false;
      const record: RememberedCredentialRecord = {
        version: 1,
        password,
        target: normalizedTarget,
      };
      const encrypted = cipher.encrypt(JSON.stringify(record));
      if (encrypted.length === 0) throw new Error('credential encryption returned no data');
      backend.set(accountId, Buffer.from(encrypted).toString('base64'));
      return true;
    },

    remove(accountId) {
      assertAccountId(accountId);
      backend.delete(accountId);
    },
  };
}

/** Only authentication rejection invalidates a remembered password.
 * Transport and availability failures keep it so the UI can offer retry. */
export function isCredentialRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('unauthorized')
    || normalized.includes('invalid_credentials')
    || normalized.includes('invalid credentials')
    || normalized.includes('wrong password')
    || normalized.includes('incorrect password');
}

/** A trusted encrypted binding that no longer resolves is invalid rather
 * than transient: require explicit authentication to bind a fresh target. */
export function isRememberedCredentialTargetRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('remembered credential');
}
