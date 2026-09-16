import type { VerifiedLoopbackTarget } from './start.js';

export interface TargetBoundWindow<T = unknown> {
  value: T;
  target: VerifiedLoopbackTarget | null | undefined;
}

/** Full coordinator-authenticated equality. Display labels and account ids
 * are deliberately absent: both can be stale or duplicated across windows. */
export function verifiedLoopbackTargetsEqual(
  actual: VerifiedLoopbackTarget | null | undefined,
  expected: VerifiedLoopbackTarget | null | undefined,
): boolean {
  if (!actual || !expected) return false;
  return actual.networkName === expected.networkName
    && actual.networkId === expected.networkId
    && actual.handle === expected.handle
    && actual.coordinatorNodeId === expected.coordinatorNodeId
    && actual.agentHandle === expected.agentHandle
    && actual.agentNodeId === expected.agentNodeId;
}

/** Return an already-open window for this authenticated destination. */
export function findWindowForVerifiedTarget<T>(
  requested: VerifiedLoopbackTarget | null | undefined,
  windows: Iterable<TargetBoundWindow<T>>,
): T | null {
  if (!requested) return null;
  for (const candidate of windows) {
    if (verifiedLoopbackTargetsEqual(candidate.target, requested)) {
      return candidate.value;
    }
  }
  return null;
}
