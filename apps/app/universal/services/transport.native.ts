/**
 * Platform transport — React Native variant.
 *
 * Resolved by Metro instead of ``transport.ts`` for iOS / Android
 * builds. Returns the native transport backed by the Swift/Kotlin
 * ``OpenAgentTransport`` native module + shared TypeScript protocol.
 */

import { createNativeTransport } from '../../common/network/native-transport';
import type { PlatformTransport } from '../../common/network/transport-types';

let cached: PlatformTransport | null | undefined;

export function getTransport(): PlatformTransport | null {
  if (cached !== undefined) return cached;
  try {
    cached = createNativeTransport();
    return cached;
  } catch {
    cached = null;
    return null;
  }
}
