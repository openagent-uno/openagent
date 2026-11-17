# openagent-identity

Product-owned identity implementation. Consumes the independently versioned Core package; Core must never import this package.

Coordinator RPCs share a connection per local `IrohNode` and coordinator, with
one independent bidirectional stream per call. Concurrent callers share an
unfinished dial; they never share an RPC response or authorization result.
Member gateways still ask the coordinator for current device membership on
every request, preserving revocation epochs and fail-closed behavior.

The RPC deadline covers dialing, stream creation, sending and reading. Failed
or cancelled streams retire their connection for future calls; other active
streams finish before that connection closes. RPCs are never automatically
replayed. `IrohNode.stop()` closes pooled connections and pending dials.

The deterministic transport benchmark and lifecycle regression tests run with:

```sh
PYTHONPATH=packages/identity/src apps/server/.venv/bin/python tests/test_coordinator_rpc_performance.py -v
```

Its fake transport records dial counts and latency separately from fresh
membership checks. Qualify deployed performance separately through real Iroh
with both coordinator and member gateway nodes.
