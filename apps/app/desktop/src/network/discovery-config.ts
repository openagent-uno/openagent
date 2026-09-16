export type NodeDiscoveryMode = 'default' | 'none';

/** Resolve the environment override without importing the native iroh addon. */
export function nodeDiscoveryMode(value = process.env.OPENAGENT_IROH_DISCOVERY): NodeDiscoveryMode {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'none' || normalized === 'off' || normalized === 'disabled'
    ? 'none'
    : 'default';
}
