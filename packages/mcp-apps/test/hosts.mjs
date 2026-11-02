/** Neutral optional host acceptance configuration, supplied outside this repo. */
export const externalHosts = JSON.parse(process.env.OPENAGENT_TEST_HOSTS || '[]');
if (!Array.isArray(externalHosts) || externalHosts.some(host =>
  !host || typeof host.name !== 'string' || host.name === 'standalone' ||
  typeof host.root !== 'string' || !host.root.startsWith('/'))) {
  throw new Error('OPENAGENT_TEST_HOSTS must contain named absolute host roots');
}
export function runtimeHost() {
  const host = JSON.parse(process.env.OPENAGENT_TEST_RUNTIME_HOST || 'null');
  if (host && (!host.identityModule || !host.actorHeader || !host.actorTokenPrefix))
    throw new Error('Runtime acceptance requires identityModule, actorHeader and actorTokenPrefix');
  return host;
}
