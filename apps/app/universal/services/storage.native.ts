/**
 * React Native storage — AsyncStorage backend.
 *
 * Metro resolves this file (via the ``.native.ts`` suffix) instead of
 * ``storage.ts`` when building for iOS / Android. The same async API
 * surface (``getItem`` / ``setItem`` / ``removeItem``) keeps the rest
 * of the universal layer unaware of the backing store.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export async function getItem(key: string): Promise<string | null> {
  return AsyncStorage.getItem(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  await AsyncStorage.setItem(key, value);
}

export async function removeItem(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}
