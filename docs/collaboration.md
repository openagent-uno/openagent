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
user must have the relevant session ACLs. App 0.18 discovers the API on connection
and uses shared requests for native typed chat, steering, model changes and session
commands. A 404/405 keeps compatibility with older gateways; transient failures
are reported. Audio/video and capability registration retain the native protocol.
Finish an active media turn before switching transports.

The root observer follows chat/history and focused run/workflow/schedule/event
views. Names and presence initials appear in the composer and history; Share
session lets its native owner add/remove collaborators by username. Corrections
and regenerations append authorized turns rather than truncating shared history.
Reopening observes the existing run; it never resends the user's input. Canonical
run IDs reconcile replay, and command history survives the live replay window.
Integrations may resolve actual avatar images from their own user directory.

Explicit withdrawal clears chat and run transcript projections even after a
socket disconnect or before the first snapshot. History reads, pagination and
search anchors are fenced across revocation/regrant and account resets, so a
delayed response cannot restore the previous grant's text. A temporary network
disconnect retains the transcript until the server confirms access again.

Run the shared protocol and transport tests with
`node --experimental-strip-types --test common/__tests__/collaboration*.test.mjs`
after installing Desktop dependencies, and type-check the service normally.
