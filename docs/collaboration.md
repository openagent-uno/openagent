# Shared-session client

`universal/services/collaboration.ts` exports an account-bound
`CollaborationClient` for the additive OpenAgent shared text API. It supports
web, React Native and Electron transports without host-specific identity data.

```ts
const shared = new CollaborationClient(authenticatedLoopbackOrigin);
const unsubscribe = shared.subscribe(() => {
  render(shared.snapshot(sessionId), shared.presence());
});
shared.observe([sessionId], { kind: 'session', id: sessionId });
await shared.sendTurn(sessionId, requestId, 'Adjust the answer', 'steer');
await shared.sendTurn(sessionId, commandId, '/model auto');
await shared.stopTurn(sessionId, requestId);
// On logout / account change:
unsubscribe();
shared.dispose();
```

Keep request IDs stable across transport retries. Aborting the HTTP signal only
detaches that request; stopping execution requires `stopTurn`. Snapshots replace
their predecessors and retain their authors. Disconnect/revocation discards live
caches; reconnect re-observes the current views without resending a turn.

The gateway must support `/ws/collaboration` and `/api/collaboration/*` and the
user must have the relevant session ACLs. Existing OpenAgentWS/native screens
continue using their existing protocol. This change supplies an opt-in client
API; it does not migrate the native chat UI or its audio/video/local-tool flows.
Integrations can render names/avatar directory lookups and presence from
`common/collaboration.ts` without coupling OpenAgent to their product model.

Run the shared protocol and transport tests with
`node --experimental-strip-types --test common/__tests__/collaboration*.test.mjs`
after installing Desktop dependencies, and type-check the service normally.
