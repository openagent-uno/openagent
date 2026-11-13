/**
 * Keychain item names for the native transport.
 *
 * expo-secure-store only accepts keys made of ``[A-Za-z0-9._-]`` and
 * rejects anything else (``:``, ``@``, spaces...) at runtime. Fixed names
 * use ``.`` separators; variable parts (account and network ids) are
 * escaped injectively so distinct ids always map to distinct keys.
 */

const NAMESPACE = 'openagent';

export const IDENTITY_KEY = `${NAMESPACE}.device-identity`;
export const NETWORK_STORE_KEY = `${NAMESPACE}.networks`;

/** Escape a UTF-8 string: ``[A-Za-z0-9-]`` stays, every other byte becomes ``_xx``. */
export function encodeKeyPart(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (const b of bytes) {
    const safe =
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2d; // -
    out += safe ? String.fromCharCode(b) : '_' + b.toString(16).padStart(2, '0');
  }
  return out;
}

export function certKey(networkId: string): string {
  return `${NAMESPACE}.cert.${encodeKeyPart(networkId)}`;
}

export function credentialKey(accountId: string): string {
  return `${NAMESPACE}.cred.${encodeKeyPart(accountId)}`;
}

const VALID_KEY = /^[A-Za-z0-9._-]+$/;

export function isValidSecureStoreKey(key: string): boolean {
  return VALID_KEY.test(key);
}
