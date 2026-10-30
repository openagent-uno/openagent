# Client Computer Capabilities

OpenAgent can execute machine-bound capabilities on the computer running an
authenticated Desktop or CLI client. The agent itself, its sessions and enabled
modules continue to run on the OpenAgent server; the client is a temporary
capability host for the interactive turn it sends.

## Execution locations

Discovery presents concrete destinations such as “Shell — Mac di Alice” and
“Shell — Agent environment”. The model receives an opaque `ToolRef`; internal
source prefixes are not part of the model-facing contract. Resolution never
crosses destinations: an unavailable client call fails instead of falling back
to the server or another online device.

The client target belongs to one turn, not to the durable session. If a session
is resumed from another device, its next turn uses that new device. Tool results,
status events and audit entries always include the execution host.

## What is local

The official host bundle advertises these machine-bound capabilities when available:

- `filesystem`
- `editor`
- `shell`
- `computer-control`
- `agent-in-chrome`

Agent in Chrome uses a dedicated persistent browser profile; it does not attach
to the user's everyday Chrome profile. Operating-system permissions still
apply. For example, macOS requires Accessibility and Screen Recording grants for
computer control.

Additional local MCP servers may be registered explicitly in
`~/.openagent/user/client-mcps.toml`. Their command, environment and secrets stay
on the device; the server receives only the public MCP catalog and schemas.

```toml
version = 1

[[mcp]]
name = "project-tools"
command = ["project-mcp", "stdio"]
env = { PROJECT_HOME = "/path/on/this/computer" }
enabled = true
```

## Enabling and revoking access

Local control is disabled until the user grants the device-level consent once.
After that grant, OpenAgent does not ask before each file, shell, screen or
browser action and does not impose an additional filesystem root. Tools inherit
the permissions of the operating-system user running the client; they do not
gain administrator/root privileges automatically.

Desktop exposes the switch and current host status in Settings. The CLI uses:

```console
openagent-cli local-tools enable
openagent-cli local-tools status
openagent-cli local-tools disable
```

Desktop and CLI share the same local consent. Disabling it disconnects the
capability channel, stops new work and cancels active calls best-effort. A local
audit records call identity, target, hashes, timing and outcome without storing
file contents, screenshots or browser secrets.

Both clients also share a single-instance `openagent-capability-host` broker over
the current operating-system user's Unix socket or Windows named pipe. The
broker supervises modules, serializes mutating work, keeps the durable
idempotency ledger and delivers background shell completion events to the
connected client instance. Official host bundles are self-contained per
OS/architecture: the release version and every bundled file's SHA-256 are
verified before Desktop or CLI starts them, so no user-installed Node.js,
Python or `npx` is required.

### Desktop host transport lifecycle

The Desktop bridge binds stdout, stderr, pending responses and cancellation to
the exact subprocess it started. A retired process cannot publish events into a
replacement connection. Concurrent starts share one completed handshake; a
failed handshake retires its executor before returning. Malformed JSON,
non-object frames and invalid response/event envelopes close that transport and
leave uncertain mutations unresolved rather than replaying them.

Cancellation rejects the local wait immediately and sends a best-effort cancel
to the same subprocess. A call deadline also cancels outstanding work; neither
path retries the operation. Durations must be finite and positive and fit
within 24 hours. The compatibility form accepts an epoch deadline within that
same remaining budget and rejects an expired deadline before dispatch.
Transport shutdown waits for the owned subprocess and escalates termination
when needed; it does not stop the shared broker or another client's process.

Development builds prefer `packages/host-tools` in the canonical product
checkout. Older source layouts retain their explicit sibling fallback.
Packaged discovery continues to require the pinned executable and complete
bundle manifest. The [30 October source qualification](../../qualification/desktop-host-bridge-2026-10-30.json)
records the bridge regressions and the remaining installed-product gates.

## Server-originated work

Only a turn received from a live authenticated Desktop or CLI instance has a
client execution origin. The following always see server MCPs only, even while a
client is online:

- scheduled-task firings;
- webhook and event deliveries;
- Telegram, Discord, WhatsApp and other channel bridges;
- automatically started workflows;
- any durable/asynchronous child run spawned from those paths.

There is no default device, last-used device or online-device fallback. A
synchronous delegated child inside the same interactive turn may inherit the
exact client origin; a later durable execution may not.

## Capability protocol

The client main process opens an authenticated `/ws/capabilities` WebSocket over
the same Iroh Gateway transport as chat and negotiates
`client-capabilities/1`. A host is keyed by the certificate-derived device ID,
its boot-scoped `client_instance_id` and a connection generation.

The protocol carries catalog registration/update, heartbeat, tool call/result,
cancellation and artifact frames. Every call has a unique ID, canonical argument
hash and deadline. The local host keeps an idempotency ledger: a completed
duplicate replays its result, while a crash after a possible side effect returns
an indeterminate result and is not silently retried.

The capability endpoint accepts only a coordinator-issued device certificate
whose public key matches the Iroh peer. Shared HTTP tokens, bridges and
agent-to-agent connections cannot register computer tools. Revoking the device
closes its chat and capability connections and fails pending calls. The server
revalidates already-connected member devices against the coordinator as well,
so a revoke, suspend or delete performed from another process takes effect on
live streams rather than only on the next reconnect.

Older clients remain compatible: they simply never open the capability channel,
so their turns receive the server catalog only.


## Observed background results (source contract)

The next product source uses Core29's optional trusted post-publication
executor hook. An explicit successful `shell_output` result with
`still_running: false` acknowledges only the registered job on the exact
client instance/generation, source, session and current execution context.
This happens after ordinary result authorization and publication; denied or
revoked results cannot consume a completion notification. A delayed duplicate
client-shell event remains acknowledged without reopening the model loop.
The original tool result and transcript are retained.

Unobserved background completions still continue normally. Their internal
reminder is not a new human message and does not prove previous assistant
output was delivered; the final answer must cover the original task on its
own. This source contract does not claim that immutable product60 or a native
client has adopted Core29.


### Native accessibility source candidate (30 October 2026)

The local host facade binds shared computer-control `snapshot_id` results to
the normalized originating account/device principal for their bounded lifetime.
A different account, device or generation cannot use the observation, and
principal release removes the ownership record. The native sidecar remains
authoritative for exact target checks and single use. Repeating an already
recorded idempotency key returns the ledger result without another native
mutation. No document contents or credentials are added to this ownership map.

The candidate Tools surface is `computer_accessibility_snapshot` and
`computer_accessibility_action` (`press`, `show_menu`, `set_value`). These are
registered through normal discovery, not hardcoded client UI buttons. The
source facade was exercised with the actual macOS native sidecar and an owned
AppKit window, including cross-account rejection, Unicode edits and one button
press across an idempotent replay. This is source qualification; published
host-tools dependencies, release locks, installed applications and other native
platforms are unchanged. Rebuild and verify the release artifacts before
claiming installed-product adoption.
