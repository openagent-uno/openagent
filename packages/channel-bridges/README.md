# OpenAgent channel bridges

Official stateless Slack, Discord, Telegram and WhatsApp adapters, shared by
standalone OpenAgent and hosts embedding their own instance of public Core.
Channels speak to the host's existing agent; they do not construct another
runtime, capability catalog, memory vault or database. They are separate from
MCP connectors used to operate a provider's APIs as tools.

This source targets component `0.1.0b12`. Source qualification covers 298 tests
and 86 subcases; closed-wheel/public artifact qualification is recorded
separately and records its normally installed Core version. These counts do not establish
real Slack or Discord provider acceptance. Real Discord end-to-end acceptance
is explicitly outside this delivery's scope, not inherited from Slack tests.

Previous immutable released component:
[`0.1.0b4`](https://github.com/openagent-uno/openagent/releases/tag/channel-bridges-v0.1.0-beta.4),
with 206 normally installed tests and 84 subcases on Core beta26. Its
[public qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/channel-bridges-0.1.0b4-2026-10-22.json)
records anonymous full asset readback, fresh normal URL installation and
Core beta24/beta26 install/import/console checks. Those receipts remain
immutable and do not establish live provider acceptance.

Beta7 adds request-scoped historical file/image/video/audio readers when the
host advertises `history_media`, with explicit omissions and unchanged fresh
audience/actor checks. Slack/Discord default to one quiet acknowledgement plus
the final host reply; `delivery_mode: live` remains an explicit opt-in. An
optional `acknowledgement_text` is host supplied, not locale inference. Hosts
must provide an authoritative final result instead of aggregated narration.
The standalone Core final-answer consumer is a separate release boundary.
See [the complete contract and bounds](../../docs/site/guide/channel-history-media.md).

Beta6 replies in the main chat for top-level Slack messages. Replies within an
existing thread stay in that exact thread, including files. Text and media
cannot switch the authorized channel or thread. Discord retains its explicit
channel/thread destination. This does not create a new thread-selection tool.

Beta5 repairs Slack file delivery when a real HTTP receiver acknowledges the
Content-Length bytes before the request generator resumes. A bounded two-chunk
lookahead validates EOF before yielding the final bytes. Exact byte counts,
file identity, fresh authorization before publication and source cleanup remain
required. Real loopback HTTP regressions cover empty and multi-chunk files,
early incomplete responses, HTTP errors, revocation and file mutation. These
tests are separate from live provider and embedded-host acceptance. See the
[source qualification](../../docs/qualification/channel-slack-upload-source-2026-10-22.json).

Install the versioned wheel with the required optional provider extra, such as
`openagent-channel-bridges[slack]`. Core is a compatible dependency, without
`[engine]` or a standalone framework pin. Importing contracts uses only the
standard library and starts no process or listener.

## Host contract v1 (beta 2 additions)

Beta4 introduced a provider-attested `BridgeConversation`, automatically
derived on messages and commands. Shared channel/thread keys exclude the
current actor and include a stable audience epoch; current actor and mapped
recipient permissions remain host-owned. An epoch change during a running
answer denies outward delivery. See [PROTOCOL.md](PROTOCOL.md) for exact
cross-language vectors, and the [standalone/embedding guide](../../docs/site/guide/embedded-channels.md)
for explicit network-user mapping. Each component release has its own qualification; earlier receipts remain
historical evidence.

Implement `BridgeTransport` in `openagent_channel_bridges.contracts`:

- `start() -> BridgeCapabilities` and idempotent `stop()` own binding-local
  resources. Stopping a bridge never closes a shared host runtime.
- `authorize_context(BridgeContext) -> bool` checks the current actor, immutable
  binding and selected account/channel/thread before provider reads, dispatch,
  commands and media. It admits the actor; it does not authorize every member
  of a group to receive the agent's answer.
- `authorize_delivery(BridgeContext) -> bool` checks current host permissions for
  the complete provider-attested audience, including the tools and memory that
  may contribute to the answer. Before `send` or `command`, and before each
  outbound text, media or progress operation, the bridge refreshes that audience
  and asks the host again. The host must check the verification timestamp and
  deny stale or unmappable recipients. A missing method, incomplete audience or
  non-boolean approval fails closed for groups, channels, threads and unknown
  conversation kinds. A verified direct conversation retains the actor-only
  compatibility fallback when an older transport lacks this method.
- `send(BridgeMessage, *, on_event=None) -> BridgeReply` resolves the host session
  and submits through its usual public run services. Use its current tools,
  prompt and vault policy. Host-owned durable event deduplication prevents
  repeated delivery from invoking the agent twice.
- `command(BridgeCommand) -> BridgeCommandResult` reauthorizes commands; the
  command cannot select a different runtime, principal or arbitrary session.
- `transcribe(context, attachment)` and `synthesize(context, text)` provide
  explicitly configured media services. There is no local model download or
  implicit standalone fallback in embedded mode.

DTOs are frozen dataclasses, with `api_version=1`. `BridgeContext` carries
`binding_id`, `provider`, provider `account_id`, `actor_id`, `conversation_id`,
`event_id`, optional `thread_id` and `reply_to_event_id`. Beta 2 adds
`conversation_kind` (`unknown`, `direct`, `group`, `channel` or `thread`),
`audience_ids`, `audience_complete` and `audience_verified_at` (Unix seconds).
Defaults are `unknown`, an empty tuple, `False` and `None`; they do not attest a
group audience. The provider SDK supplies these routing and membership facts,
never host permission claims. The host maps verified SDK actors and recipients
to its own principals; another participant's message never inherits the owner.

`BridgeMessage` contains ordered `BridgePart` text/media and separately
attributed `history`. Slack/Discord history defaults to 20 messages, configurable
with `context_messages=0..200`. Its JSON byte budget includes attribution,
media reader metadata and historical speech transcripts. `history_max_bytes`
is a negotiated integer from 65,536 to 262,144, defaulting to 65,536. Both host
and bridge must enforce the advertised limit. Only the same authorized
channel/thread is read. Trigger duplicates are excluded and records are
chronological. A byte/256-part overflow or incomplete bounded thread scan
fails with explicit authorized unavailability, without starting a partial task.
History is untrusted quoted data and cannot grant permission or replace the
current author. Replies retain the originating channel/thread.

Host integrations must revalidate output audience for shared channels, including
tool results and memory reads. Sharing an agent's memory does not make all of its
private knowledge visible to every channel member. Persistent learning follows
the same host policy and vault as other sessions, without a channel-only copy.
Provider membership proof and host authorization are separate requirements:
listing everyone in a channel does not grant them access to private results.
Unsupported or incomplete membership paths remain blocked rather than using
message authors or a partial cache as a substitute audience.

Non-Python hosts can run `openagent-channel-bridge` as a binding-local child.
Its NDJSON protocol is `channel-bridge-ipc/v1`; `--describe` prints the contract
without starting a provider. Typed requests and responses preserve the same
transport authorization boundary. Media cross the pipe through bounded,
request-scoped readers/uploads and SHA-256, never a local filesystem path.
`--describe` also reports the package version. A `configured` reply accepts the
binding configuration; `start()` exchanges host capabilities. Neither proves
that provider authentication, intake or live model delivery is ready.

## Provider installation

Provider SDKs are optional extras. Low-level Slack Socket Mode accepts an
operator's existing bot and app-level credentials; this is an operator-managed
deployment option, not an end-user onboarding requirement. A user OAuth token
from the Slack MCP connector is not a channel bot token.

The managed Slack mode uses the existing official OpenAgent app with a
separately authorized bot grant and authenticated, binding-scoped event routing.
Existing connector public distribution alone does not establish a live bot.
User connector grants and bot grants remain separate; this mode does not inherit
MCP permissions or require users to register another app.

## Managed Slack (beta 3)

`HostedSlackBridge` uses the optional central service protocol
`openagent-slack-channel/v1`. Its [service/API contract](https://github.com/openagent-uno/openagent-tools/blob/dfca393d3d2ac1f83c15a9b39529abf2dc8eac25/packages/connectors/channels/slack/README.md)
describes the existing-host `Start`, `Status`, `Activate`, `Session` and
`Disconnect` calls, six bot scopes, callback/events routes and additive app
configuration. The opt-in service is online: HTTPS health 200, unsigned event
403 and a signed challenge 200 were verified with a dedicated encrypted channel
vault. The app manifest changes have not been saved; no bot grant or real
mention-to-agent-to-reply acceptance is claimed. Service readiness does not
automatically enable a consumer binding.

The host selects one existing agent with the explicit recipient
`(workspace_id, subject_id, agent_id)`, then starts a binding for one Slack
workspace/channel. The human sees that destination before Slack consent.
After bot installation, invitation and channel verification, the host explicitly
activates the binding and obtains an **8-hour binding-scoped service session**.
It keeps that capability private; central custody retains the bot access and
refresh tokens. Creating a new session replaces the previous session for that
binding. Expiry/revocation stops intake and requires the host to obtain a valid
session; there is no token fallback or automatic host enrollment.

```python
from openagent_channel_bridges import HostedSlackBridge

bridge = HostedSlackBridge(
    transport=host_transport,
    binding_id=stored_service_binding_id,
    service_binding_id=stored_service_binding_id,
    service_origin=configured_service_origin,
    service_app_id="A0C9XC9JHTK",
    session_token=private_service_session.token,
    context_messages=20,
    live=False,
)
await bridge.start()
# Host lifecycle owns shutdown; the existing host runtime stays alive.
await bridge.stop()
```

The hosted implementation needs the package's normal HTTP dependency, not the
optional Socket Mode SDK extra. Non-Python hosts use the same child/host IPC;
send this configuration through **private stdin**, never argv or logs:

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

These are placeholders. The outer and service binding IDs must match. This
hosted configuration accepts no Slack bot/app token. With `listen_channels`
omitted, only the service binding's channel is selected; optional local user or
channel restrictions cannot broaden it. A binding routes to its selected agent,
not a global broadcast, another agent or an implicit standalone fallback.

This profile is **opt-in and text-only**: mentions, bounded same-channel/thread
history and text replies. DMs, attachments, pickers and slash-command ingress
are outside the managed profile. The host still supplies `authorize_context`,
`authorize_delivery` and its own normal runtime/run services. Every participant
must map to an authorized host principal; a bot/channel membership proof does
not make private tools or memory visible to the whole audience.

The central queue ACK and write-operation deduplication do not replace durable
host event/run idempotency. The host must persist the immutable accepted request
and outcome under a binding/account/event key so a replay or restarted child
finds the same run instead of executing tools again. Keep unknown write outcomes
for reconciliation; do not issue a new operation ID and blindly resend. Hosted
`configured`/`start` or a healthy service are not real provider acceptance.

## Provider audience boundaries

Slack refreshes the authenticated bot/workspace binding and reads real Web API
membership with `conversations.members`, bounded to ten pages of at most 100
members and 1,000 IDs. Missing scopes, API failures, repeated cursors or a
truncated result leave the audience incomplete and block group dispatch and
delivery. Direct participants are verified through `conversations.info`.
Thread delivery uses the complete channel audience, not only thread authors.
The installation needs the corresponding provider permissions; host ACL approval
is still required for all recipients.

Discord defaults to `members_intent=False`. An operator can explicitly enable
it to request the SDK guild-member intent; this does not change Discord's app
configuration or grant a provider permission. For ordinary guild channels,
the bridge uses fresh REST guild/channel metadata and at most 1,001 member
records to detect the 1,000-member limit, then computes visibility with current
channel permissions. Missing intent, incomplete membership or an unsupported
channel leaves the audience incomplete. Discord threads and group DMs remain
blocked until their full visibility can be attested; a parent channel's members
are not substituted. Direct-message recipients are verified through the SDK.
Complete group audience support is not asserted for the other providers.

Real provider installation, OAuth consent and live model acceptance are separate
from SDK fixtures. See the qualification receipt accompanying each release for
the exact tested boundary.


Telegram private conversations are verified through the authenticated SDK bot
and a fresh `get_chat` result matching the actual actor. Telegram groups cannot
provide a complete audience through the Bot API and remain denied. WhatsApp
currently leaves the conversation kind unknown and audience incomplete; typed
runtime dispatch and result delivery remain denied until an authenticated
recipient proof is implemented. These limits also apply to the typed standalone
adapter; the historical untyped compatibility API does not attest audiences.


Beta8 keeps late replies to canceled IPC requests from terminating the control
reader. IDs are never reused, ignored cancellation tombstones are bounded and
carry no authority. Normal unknown and duplicate responses still fail closed.
`history_max_files` defaults to 16 and may be explicitly advertised as 16–64
only together with `history_media`. Current-only inputs and output uploads
remain capped at 16; historical input remains limited to 64 MiB combined and
32 MiB per file. This is a bounded selected window, not an all-history tool.


Beta9 acknowledges an admitted quiet turn before historical downloads and
speech. Provider audience proofs are refreshed at file, ingestion and delivery
boundaries; each byte chunk still checks the host's current actor, binding and
recipient authorization. A request-local proof is refreshed during slow
transfers after ten seconds; host grants are never cached. Requested history
failure becomes an explicit authorized error, not an invented empty context.
The CLI emits only the closed content-free diagnostic schema documented in
`docs/site/guide/channel-history-media.md`; consumers must discard other stderr.

## Native processing indicators

Discord, supported existing Slack assistant threads and supported Green API
clients use an authorized native indicator independently of quiet/live delivery.
Slack main-channel/top-level DM replies keep their placement and have no typing
fallback. No message, reaction, permission or new thread is added for typing.
See [capabilities and lifecycle limits](../../docs/site/guide/channel-native-typing.md).
Component fixtures do not establish live delivery in provider accounts.
