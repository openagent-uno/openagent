# Embedding official channels

Component release:
[`0.1.0b5`](https://github.com/openagent-uno/openagent/releases/tag/channel-bridges-v0.1.0-beta.5).
The normally installed public beta5 wheel passes **213 tests and 84 subcases
on Core beta26**, with zero skips. All six public assets were downloaded
anonymously over HTTPS and checked in full. Fresh public-URL installation,
installed payload bytes, dependency consistency and actual console/start-RPC/EOF
checks passed. Minimal normal installs passed on Core beta24 and beta26 without
the standalone framework or engine extra. The
[beta5 qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/channel-bridges-0.1.0b5-2026-10-22.json)
binds source `63e35f0f3e7ee9a32165a9ac9156e7132841c2a6` and the 109,832-byte wheel.
These results qualify the component; provider and standalone product acceptance
have separate receipts.

Beta5 repairs Slack upload completion after a successful HTTP byte transfer.
The source reaches EOF and validates it before yielding the final bytes, while
byte counts, file identity, fresh authorization and cleanup remain required.
Real loopback HTTP tests include empty/multi-chunk files, early incomplete
responses, HTTP failure, late revocation and mutation. The conservative buffer
bound is 192 KiB: two current 64 KiB chunks plus the retained initial chunk.
The immutable package's earlier two-chunk wording counted only current
lookahead chunks; it did not count that initial reference. Memory does not grow
with file size. The source/provider-isolated diagnostic is recorded
[separately](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/channel-slack-upload-source-2026-10-22.json).

Earlier [beta4](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/channel-bridges-0.1.0b4-2026-10-22.json),
[beta3](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/channel-bridges-0.1.0b3-2026-10-21.json)
and [beta2](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/channel-bridges-0.1.0b2-2026-10-21.json)
receipts remain historical and immutable. Beta4 introduced shared conversation
keys, beta3 the optional text-only hosted Slack path, and beta2 audience
attestation.

Channels are conversational entrances to the host's existing agent. They are
independent from MCP connectors that expose Slack, Discord or another service
as tools. A message arriving through a channel uses the host's normal public
run API, configured capabilities and memory vault. It does not start a second
agent or copy its knowledge into a provider-specific database.

## Package and contract

Beta 4 adds stable channel/thread descriptors and keeps actor authority separate
from shared history. See the
[protocol](https://github.com/openagent-uno/openagent/blob/main/packages/channel-bridges/PROTOCOL.md)
for exact framing, audience epochs and golden vectors. Provider fixtures cover
shared threads, complete audiences, media and voice callbacks, including denial
when the audience changes during a run. Real Discord end-to-end acceptance was
explicitly excluded and is not qualified. Slack live acceptance is tracked
separately and must not be inferred from fixture, IPC or installed-wheel results.

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

## Standalone mapped channels

Standalone Slack/Discord can explicitly map an authenticated provider account
to current network users. Configure `channels.<provider>.identity` with exactly
`tenant_id`, `account_id`, and `user_bindings` (provider-user-ID to network-user
handle). Every audience member needs a distinct current mapping; there is no
default-owner identity. Keep the provider `allowed_users`/`listen_channels`
configuration explicit as well. For example, an operator configuration contains:

```yaml
channels:
  slack:
    # Resolve provider credentials through the normal operator configuration.
    listen_channels: [C_PRIVATE_TEAM]
    identity:
      tenant_id: network-example
      account_id: T_EXAMPLE
      user_bindings:
        U_ALICE: alice
        U_BOB: bob
```

This selects an in-process transport into the installation's existing public
Runtime, SQLite journal, catalog, model and vault policy. It does not create a
bot runtime or a certificate impersonating the owner. The canonical store owns
session/history/recipient rows. Events deduplicate across restarts; shared
session scope excludes the current actor and includes the provider audience and
current mapped-principal epoch. New membership or changed mappings open a new
epoch rather than disclosing old history. Existing private bridge journals are
retained; they are not rewritten or deleted. Missing mapping keeps the legacy
DM transport; it does not enable groups. Gateway slash commands are not executed
with the internal bridge certificate in mapped mode.

Inbound generic files/images use the same public session-scoped
`ArtifactRepository` as normal sessions, with bounded authorized staged reads.
Output uses canonical session-linked artifacts and reauthorizes before reading
and delivery. Unlinked local paths do not become downloadable file authority.
Voice uploads preserve their original filename, MIME, digest and provider ID.
Slack WebM/M4A and Discord Ogg/Opus use the same speech-service factory and
configuration as the normal gateway/Telegram path, including its existing local
fallback default. `voice.local_fallback: false` explicitly disables that route.
When neither configured STT nor the selected fallback produces text, the normal
voice-unavailable response asks the sender to type the message.

## Mentions, history and response routing

Slack and Discord use `context_messages=20` by default. The accepted range is
0–200; zero disables history reads. A second hard limit bounds the attributed
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

## Managed official Slack

Beta 3 adds `HostedSlackBridge` for a centrally managed
OpenAgent Slack bot. End users connect the existing official app; they do not
supply Slack bot/app credentials or create their own app. The separate
[`openagent-slack-channel/v1` service contract](https://github.com/openagent-uno/openagent-tools/blob/dfca393d3d2ac1f83c15a9b39529abf2dc8eac25/packages/connectors/channels/slack/README.md)
covers installation authentication, bot scope/rotation checks, callback/events
routes, encrypted custody and the additive app configuration. The Slack user
connector/MCP grant remains a different capability.

The opt-in managed service is online: HTTPS health returned 200, unsigned events
were denied with 403, and a signed challenge returned 200. Its channel vault is
dedicated and encrypted. The Slack app manifest changes are **not saved** and no
production bot grant or live mention-to-agent-to-reply acceptance exists yet.
A healthy service does not activate any host or agent automatically.

The host's authenticated product selects an existing agent and records an exact
recipient `(workspace_id, subject_id, agent_id)` and Slack workspace/channel.
Its setup sequence is:

1. Call the channel service's signed `Start` using the existing registered host
   identity and that recipient. Open the returned destination-specific consent
   URL, then poll signed `Status`.
2. After OAuth reaches `authorized`, invite the bot to the selected channel and
   call signed `Activate`. Current bot and consenting-human membership must be
   verifiable; consent alone does not connect an agent.
3. Obtain a signed `Session` response and pass its private binding-scoped
   capability into the child. It lasts **8 hours**; a replacement session
   invalidates the previous session credential. Central bot tokens never go to
   the destination host.
4. On disconnect, call the service's signed `Disconnect` and stop that child.
   Other authorized destinations keep their shared bot connection. Expired or
   revoked sessions stop intake; reconnect/renewal is an explicit host action.

For the stdio child, use the following `configure` frame through private stdin.
Angle-bracket values are placeholders, not working credentials:

```json
{
  "protocol": "channel-bridge-ipc/v1",
  "type": "configure",
  "request_id": "configure-slack",
  "provider": "slack",
  "binding_id": "<service binding ID>",
  "config": {
    "service_origin": "https://auth.openagent.uno",
    "service_binding_id": "<same service binding ID>",
    "service_app_id": "A0C9XC9JHTK",
    "session_token": "<private service session>",
    "context_messages": 20,
    "live": false
  }
}
```

`service_origin` selects the hosted implementation. The outer and service
binding IDs must be identical; `service_app_id` identifies the existing official
app. No `bot_token` or `app_token` is accepted in this configuration. Keep the
service session out of settings exports, argv, logs and model context.
With `listen_channels` omitted the adapter selects only this binding's channel;
optional local restrictions cannot broaden the server binding. Python hosts can
construct `HostedSlackBridge` with the same fields and their explicit transport.
No Socket Mode SDK extra is needed for the managed HTTP path.

This is an **optional text-only** profile: mentions, bounded same-channel/thread
history and text replies. DMs, files/media, interactive pickers and slash-command
ingress are not part of it. Each binding selects one agent; there is no global
broadcast, automatic enablement, host registration or fallback to another
agent/runtime. The host still maps the real sender and complete current audience
to its own identities and policy through `authorize_context` and
`authorize_delivery`, then dispatches its existing public run services. A shared
bot grant never authorizes sharing every private memory/tool result.

Durably map `(binding, provider account, event ID)` and the immutable request hash
to the host's existing run before acknowledging successful processing. A replay
or restarted child must find that run/outcome, not repeat tools or append a new
turn. The service's durable queue ACK and outgoing operation IDs do not provide
host run idempotency by themselves. Unknown write outcomes need reconciliation,
not blind resend. The released component, `configured`/`start`, service health
and synthetic fixtures do not establish production OAuth or a real
managed-channel round trip; those remain pending evidence.

## Operator-managed Slack HTTP intake

`SlackBridge.handle_event` exposes the same provider parsing used by Socket Mode
for an external authenticated intake. `verify_slack_event` in `slack_ingress`
validates the raw HTTP signature, five-minute timestamp window and expected
app/workspace before returning a typed envelope. This follows
[Slack's request-signing contract](https://docs.slack.dev/authentication/verifying-requests-from-slack/).
The operator must enqueue/deduplicate durable receipts before acknowledging,
bind each installation to authorized host destinations, and deliver through an
authenticated channel. Do not run a model in the HTTP acknowledgement window.

The `verify_slack_event` helper itself does not deploy the managed service or
provide OAuth installation.
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
