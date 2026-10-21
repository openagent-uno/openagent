# Embedding official channels

Component release:
[`0.1.0b2`](https://github.com/openagent-uno/openagent/releases/tag/channel-bridges-v0.1.0-beta.2).
The installed beta 2 wheel passes 133 tests and 30 subcases on Core beta 26,
alongside 62 standalone source regressions and a minimal Core beta 24 smoke.
The [qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/channel-bridges-0.1.0b2-2026-10-21.json)
distinguishes component checks from remaining provider acceptance.
They qualify the component boundary; they do not establish a live shared
Slack bot installation or a new standalone product release. Beta 1 remains
immutable; beta 2 adds explicit conversation type and audience attestation.

Channels are conversational entrances to the host's existing agent. They are
independent from MCP connectors that expose Slack, Discord or another service
as tools. A message arriving through a channel uses the host's normal public
run API, configured capabilities and memory vault. It does not start a second
agent or copy its knowledge into a provider-specific database.

## Package and contract

`openagent-channel-bridges` is independently versioned in this repository under
`packages/channel-bridges`. It contains the shared delivery orchestration and
Slack, Discord, Telegram and WhatsApp adapters. Optional SDK extras are selected
per deployment. It does not depend on the standalone framework, identity system,
dashboard, client transport or a particular Core beta; it accepts compatible
public Core versions without the engine extra.

The public API is `openagent_channel_bridges.contracts`, version 1:

| Contract | Responsibility |
| --- | --- |
| `BridgeContext` | Immutable binding, provider account, actor, conversation type, event and thread/reply identifiers; SDK-attested audience and verification time |
| `BridgeMessage` | Ordered text/media parts, attributed bounded history and optional presentation overlay |
| `BridgeTransport` | Binding-local lifecycle, authorization, public run dispatch, commands and configured media services |
| `BridgeReply` / `BridgeEvent` | Ordered results/progress and opaque host session/run references |
| `BridgeCommand` / `BridgeCommandResult` | Original actor context, supported command and typed picker results |

Provider IDs are routing data. The transport maps authenticated provider actors
to host principals and rechecks the current grant. Neither message text,
history, picker values nor an internal-looking identifier can select another
agent, tenant, session or tool executor.

```python
from openagent_channel_bridges import SlackBridge

bridge = SlackBridge(
    transport=host_transport,   # Existing runtime/run API and policy
    binding_id=stored_binding_id,
    bot_token=resolved_bot_credential,
    app_token=resolved_socket_mode_credential,
    allowed_users=allowed_provider_users,
    listen_channels=allowed_provider_channels,
    context_messages=20,
)
await bridge.start()            # Long-lived intake loop
# On disable or shutdown, from the host lifecycle task:
await bridge.stop()             # Does not close the host's shared runtime
```

The credential example is for an operator-managed Socket Mode installation.
It is not a requirement for end users to register their own Slack app. Tokens
belong in the host's secret store; settings carry references and status only.

Implement `start`, `stop`, `authorize_context`, `authorize_delivery`, `send`,
`command`, `transcribe` and `synthesize` on the transport. `authorize_context`
validates the immutable binding, real sender, provider account and target
before input and provider reads. After the SDK has attested the current
audience, `authorize_delivery` rechecks every recipient against the host
identity and agent policy before model dispatch, commands and every output
chunk/file. Both must return a literal boolean. `send` submits
through the same public runtime services as the host UI. Durable event
deduplication, session mapping, principal resolution and current tool grants
remain host responsibilities.

## Mentions, history and response routing

Slack and Discord use `context_messages=20` by default. The accepted range is
0–100; zero disables history reads. A second hard limit bounds the attributed
JSON history to 65,536 UTF-8 bytes. Only bounded provider reads from the same
authorized channel or thread are used. Slack thread replies require forward
pagination: at most ten pages of 100 records are inspected. If that cannot
reach the end before the trigger, history is omitted with a fixed operational
warning rather than misrepresenting an old prefix as the latest messages.
Trigger duplicates are excluded,
chronological order is retained, and oversized records are omitted rather than
cut into misleading fragments.

Channel mentions trigger the selected agent; ordinary unmentioned channel
messages do not silently run it. Replies use the originating thread/channel.
Every history record retains its author and event ID and is untrusted quoted
context, separate from the current author's request. Permission checks use the
current sender, never a history author or the binding owner's identity.

The host chooses sessions without creating a new runtime/vault. Facts learned
under its authorized memory policy remain available to later authorized host
sessions. A shared channel audience must still be allowed to see tool and
memory results. Access from one private session never implies publication to
every channel member. Client-only tools remain unavailable unless that channel
has its own valid capability grant; there is no fallback to an online computer.

Beta 2 adds `conversation_kind`, `audience_ids`, `audience_complete` and
`audience_verified_at` to `BridgeContext`. The default is unknown/incomplete.
Only provider SDK/API evidence establishes a direct conversation; channel ID
prefixes and user-supplied recipient lists are insufficient. Group delivery
requires a complete audience and an explicit `authorize_delivery` host policy.
Each human must map to a host identity authorized for the selected agent; an
unknown recipient or incomplete lookup denies dispatch and publication.

Slack reads current membership through its authenticated Web API, bounded to
ten pages of 100 members and excluding only its verified own bot. Discord
requires explicit `members_intent=True` and the corresponding existing vendor
grant to enumerate current guild members through REST with current roles and
channel permissions. It defaults off; no vendor permission is silently
enabled. Discord threads and group DMs remain incomplete and are denied.
Membership is refreshed before the run and each result publication. This
reduces stale authorization; provider reads and writes are not atomic, so a
provider-side membership change in between remains an integration boundary.

## Process bridge for non-Python hosts

See the exact [NDJSON frame and media contract](https://github.com/openagent-uno/openagent/blob/main/packages/channel-bridges/PROTOCOL.md).

`openagent-channel-bridge` runs one configured binding as a child process, using
NDJSON protocol `channel-bridge-ipc/v1` on stdin/stdout. `--describe` returns the
non-sensitive protocol metadata without starting an SDK. Logging goes to stderr.

The parent sends one `configure` frame with `request_id`, provider, binding ID
and provider configuration. The child replies `configured`, then sends
correlated `request` frames for `start`, `authorize_context`, `authorize_delivery`, `send`, `command`,
`transcribe`, `synthesize` and `stop`. The parent returns `result` or `error` with
the same request ID. Progress uses correlated `event` frames. No command lets
the parent fabricate a provider event or select another runtime from message
arguments. The host dispatches these requests through its existing services.
`configured` and `start` acknowledge configuration/host capabilities; neither
is proof of provider login, readiness or a live message round trip.

Credentials are supplied by the parent secret store through the private pipe,
never command-line arguments, logs or a model tool. Input media use an opaque,
request-scoped reader reference with bounded `read_artifact` chunks. A stable
provider attachment ID and SHA-256 identify content separately from the
temporary reader handle. The parent ingests those bytes into its own durable
file service before completing the request. Local staging paths never cross
the wire. Output files are uploaded through bounded staging messages and a
verified final digest; a model-supplied host path is not accepted as media.

EOF cancels this child binding and closes its staging resources, without
stopping the parent's agent. An uncertain provider mutation or accepted host
run is not automatically retried. The durable host event/run journal owns
reconciliation after process or network failure.

## Slack HTTP intake and shared app setup

`SlackBridge.handle_event` exposes the same provider parsing used by Socket Mode
for an external authenticated intake. `verify_slack_event` in `slack_ingress`
validates the raw HTTP signature, five-minute timestamp window and expected
app/workspace before returning a typed envelope. This follows
[Slack's request-signing contract](https://docs.slack.dev/authentication/verifying-requests-from-slack/).
The operator must enqueue/deduplicate durable receipts before acknowledging,
bind each installation to authorized host destinations, and deliver through an
authenticated channel. Do not run a model in the HTTP acknowledgement window.

This helper does not deploy a hosted service or provide OAuth installation.
The existing official Slack application's user connector grant is separate
from a channel bot installation. Public distribution alone does not establish
bot scopes, event subscriptions, signing-secret custody or host routing.
The app identity may be reused with separately disclosed bot grants; connector
permissions must not become channel permissions automatically.

The normal member-bot experience requires those configuration and installation
steps followed by live acceptance. Until they are completed, a visible settings
card or a passing SDK fixture must not be shown as a connected official bot.
Do not create a duplicate app or ask each user for app secrets as a substitute.

## Standalone compatibility and verification

The standalone retains its WebSocket/media adapter and historical import paths;
the provider code is shared with embedded hosts. Embedded mode has no implicit
localhost gateway, default learning database or voice-model download. Optional
media capabilities return unavailable when the host does not supply them.

Typed standalone ingress sessions now partition account, actor and thread to
prevent one sender's burst from using another sender's authority. Existing
legacy transcripts remain stored; they are not silently imported into a newly
authorized actor scope. The historical untyped compatibility API retains its
original session hints. The old standalone WebSocket message contract does not
carry a durable provider event ID, so restart-safe provider deduplication is not
claimed for that transport. An embedding host must bind the supplied event ID
to its normal durable run idempotency service.

Component qualification checks the public Core boundary, same-runtime tool and
memory fixture, authorization denial/revocation, event identity, bounded history,
thread routing and lifecycle ownership. Synthetic provider events do not prove
real OAuth, SDK connectivity or an installed bot. Versioned release receipts
identify those remaining provider boundaries explicitly.


Telegram private conversations are verified through the authenticated SDK bot
and a fresh `get_chat` result matching the actual actor. Telegram groups cannot
provide a complete audience through the Bot API and remain denied. WhatsApp
currently leaves the conversation kind unknown and audience incomplete; typed
runtime dispatch and result delivery remain denied until an authenticated
recipient proof is implemented. These limits also apply to the typed standalone
adapter; the historical untyped compatibility API does not attest audiences.
