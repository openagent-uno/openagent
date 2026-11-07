# Client Computer Capabilities

The Python identity transport supplies the pinned Iroh binding with an event-loop
adapter that schedules foreign callback cleanup through the owner loop's
thread-safe API. Native callback release preserves normal task cancellation,
context propagation and asyncio debug checks without patching the binding.

OpenAgent can execute machine-bound capabilities on the computer running an
authenticated Desktop or CLI client. The agent itself, its sessions and enabled
modules continue to run on the OpenAgent server; the client is a temporary
capability host while it is connected and has consented to local access.

## Execution locations

Discovery presents concrete destinations such as “Shell — Mac di Alice” and
“Shell — Agent environment”. The model receives an opaque `ToolRef`; internal
source prefixes are not part of the model-facing contract. Resolution never
crosses destinations: an unavailable client call fails instead of falling back
to the server or another online device.

For a private authenticated human ingress, the standalone grants current access
to every consented connected device owned by that same verified human in the
same network. Selecting a tool reference always selects one exact device,
process and generation. Another user's devices are never inherited. Resume
recomputes the grant set from current ownership and connections; a saved session
or offline inventory confers no access. Private mapped Slack/Discord turns use
that same verified network user, with the complete provider audience and mapping
revalidated before tools and publication. Shared channel audiences receive no
personal device grants. Deferred work and agent certificates receive no new
interactive grants. An authorized synchronous child can inherit the parent's
exact leases; it cannot discover additional destinations.

Legacy private Telegram/WhatsApp bridges keep their own principal. To grant one
verified sender access to a native user's devices, configure the explicit
mapping below. Device access is independent of vault/catalog owner trust:

```yaml
runtime_tool_audiences:
  device_owner_channels:
    telegram:
      "155490357": alice
```

The sender must also remain in `channels.telegram.allowed_users`. WhatsApp uses
the same fields under `whatsapp`. The exact bot account/private route, current
native owner, certificate binding and connected device consent are checked again
on every invocation and result publication. This grants device access only;
it never aliases the bridge as that user, changes session ownership, or shares
private device access with a group. Unmapped/unsupported bridge ingress remains
denied; an allowlist alone never confers device ownership. Tool results, status events
and audit entries include the exact execution host.

Core exposes optional interaction grants and generic sources. It imposes no
client/user count, enrollment scheme or sharing policy: hosts can use zero, one
or many clients and supply different authorized topologies through public
contracts. The standalone's same-owner policy is product composition.

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

The gateway accepts `screenshot` as a compatibility spelling for the client
desktop tool's read-only `get_screenshot` action. It resolves that spelling
before dispatch and rejects actions outside the advertised desktop action set
before they can acquire the local write lock. The same rules apply to native
sessions and mapped channels with access to the exact device.

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

Device access requires a current trusted interactive grant. Desktop and CLI
turns derive that grant from the authenticated native user; supported private
channel turns use the verified audience and explicit owner mapping described
above. A channel allowlist or an online client alone does not create a grant.
The following see server MCPs only:

- scheduled-task firings;
- webhook and event deliveries;
- unmapped, unsupported or shared-audience channel turns;
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

## Devices and session details

Session sharing opens from the share icon beside **Participants** in session
details. Its modal supports choosing an active network user or entering an exact
username, granting collaboration and removing existing grants. Session ACLs
remain authoritative; the server checks the current tenant's active native
user directory before granting access. Unknown/suspended users are rejected
without advancing the ACL; stale grants can still be removed. Sharing a
conversation never shares a personal computer.

The agent's own desktop is named **`<Agent name>'s Computer`**, distinct from
connected-device labels. A headless server needs a complete graphical session;
Xvfb plus Chromium alone has no window manager or taskbar. See
[server desktop provisioning](https://github.com/openagent-uno/openagent/blob/main/docs/server-browser-mcps.md).

The App sidebar includes **Devices**, a responsive grid of known computers with
online/offline status and the modules each host advertises. Restarting a client
process does not create a second card for the same certified device. A device
is online here while its consented capability connection is live; opening an
App without enabling its local tools does not grant the agent those tools.
Offline inventory is descriptive and cannot authorize execution.

Session details contain **Participants** (current presence and authors retained
across the authorized session, independently of loaded transcript pages) and **Devices** used by client-tool invocations.
Device-use metadata starts with this feature; it does not claim to reconstruct
older history. The standalone keeps this metadata beside its main database in
`<database path>.devices.sqlite3`; include it in installation backup/retention.
It contains device identities, labels, module names and timestamps, never tool
arguments, file contents or screenshots.

**Open a computer** lists currently authorized `computer` capabilities, including
the agent environment when its configured tool source provides a real desktop.
It opens a responsive modal with screen refresh, pointer actions, scrolling,
keyboard shortcuts and direct typing. It uses the same public capability catalog
and exact references as agent execution, with current session/device checks on
every request. Interaction is deterministic and does not start a model turn.
Qualified desktop hosts advertise optional `openagent-video/1` support. Their
view receives continuous H.264 video over the authenticated session connection,
with bounded encoding/decoding queues and current authorization on every packet.
Local playback overload can restart only that exact stream at a lower frame
rate (20 to 10 to 5 fps), with at most three recoveries in 30 seconds. This never
replays input; access failures, malformed packets and unsupported decoders remain
explicit errors. A renewed stream revalidates the same tool reference and owns a
new encoder; its previous encoder and decoder are closed first.
The App renews a healthy viewing stream after 270 seconds, before the public
300-second producer limit. Renewal reauthorizes the same exact tool and never
replays pointer or keyboard operations. Pause and close cancel renewal; a
revoked or unavailable destination remains an explicit failure.
Closing, disconnecting, revoking access or a slow viewer stops its owned producer;
no video recording is persisted. Core owns generic stream authorization, Tools
owns capture/encoding/decoding, and the standalone owns identity and transport.
Server-host desktops use the same optional public adapter when their configured
native source passes protocol qualification. No virtual desktop is provisioned.
Older hosts use a screenshot fallback every 500 milliseconds, with at most one
request in flight; its polling stops on close, hidden page or error. Streaming
hosts issue no screenshot polling. Input is
ordered, bounded, and never automatically retried after an uncertain failure.
Consecutive text still waiting behind an in-flight input is coalesced without
changing pointer/shortcut order, so fast typing does not fill the input queue
with one request per character. Ctrl/Command+V uses the viewer's normal paste
event and sends its text to the exact computer, independently of the remote
computer's clipboard.
Modified letter shortcuts send the base lowercase key plus explicit modifiers;
Shift is applied once. Ordinary text input keeps its original case and Unicode.
Escape stays in the focused desktop; it does not dismiss the computer view.
Closing the view cancels pending reads best-effort; a sent input may have already
executed. An offline/revoked desktop is never replaced by another destination.
OS screen-capture/input permission failures are displayed by the view.

A new local chat has no durable session authorization yet. Its details explain
that the first message starts the session, and defer participant, sharing,
device and related-run requests until then. A server-confirmed history entry or
live run clears this local UI hint; it never grants access by itself. Shared
HTTP-run snapshots clear it only when they contain an accepted run. An empty
observation is not a run acknowledgement. Native live frames and authorized
canonical history use the same transition, so a started chat exposes its
participants, sharing and authorized computers without reopening the App.

## Cold desktop helper startup

The App gives its signed, frozen local helper a separate bounded 60-second
initialization budget (routine control replies remain bounded to 10 seconds).
It reports **Starting** while initialization is pending, reads canonical consent
before advertising tools, and retires a helper whose startup deadline expires.
This accommodates cold OS signature checks/imports without repeatedly killing
a still-starting helper. The consent description covers authorized private
sessions/channels and does not imply automatic sharing with group recipients or
background work. Native releases and physical acceptance are recorded separately.
