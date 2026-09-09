# Shared-session API

After connecting a `GatewayClient` normally, use `client.collaboration()` to
attach to the shared text API through the same authenticated Iroh loopback.

```python
shared = client.collaboration()
# Run observation concurrently with input handling:
async for frame in shared.observe([session_id], focus={"kind": "session", "id": session_id}):
    render(frame)  # replace shared_state; clear caches on shared_reset/revoked

await shared.send_turn(session_id, request_id, "Adjust the answer", delivery="steer")
await shared.send_turn(session_id, command_id, "/compact")
await shared.stop_turn(session_id, request_id)
```

The observer is an async iterator. Close it with `aclose()` when changing views;
reconnecting/resubscribing never sends input or stops a generation. Transient
disconnects produce `shared_reset` before backing off. Authentication/unsupported
server errors propagate, and account-bound instances never share a cache.

Retain the same request ID/payload when retrying a lost HTTP reply. Server
deduplication lasts 60 seconds after completion in the current process; it does
not promise exactly-once execution across a restart. Cancelling the HTTP task
does not stop the server-owned run. Explicit stop targets only the supplied ID.

This is an additive programmatic client surface. Existing interactive CLI,
voice/attachment protocol and command handling remain compatible and unchanged.
The shared endpoint currently accepts text and session commands; local machine
capabilities still belong to the existing authenticated native transport.

Tests: `python -m unittest discover -s tests -p test_collaboration.py -v`.
