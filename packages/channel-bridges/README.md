# OpenAgent channel bridges

Official stateless Slack, Discord, Telegram and WhatsApp adapters, shared by
standalone OpenAgent and hosts embedding their own instance of public Core.
Channels speak to the host's existing agent; they do not construct another
runtime, capability catalog, memory vault or database. They are separate from
MCP connectors used to operate a provider's APIs as tools.

Install the versioned wheel with the required optional provider extra, such as
`openagent-channel-bridges[slack]`. Core is a compatible dependency, without
`[engine]` or a standalone framework pin. Importing contracts uses only the
standard library and starts no process or listener.

## Host contract v1

Implement `BridgeTransport` in `openagent_channel_bridges.contracts`:

- `start() -> BridgeCapabilities` and idempotent `stop()` own binding-local
  resources. Stopping a bridge never closes a shared host runtime.
- `authorize_context(BridgeContext) -> bool` checks the current actor, immutable
  binding, selected account/channel/thread and result audience before history
  reads, dispatch, commands, media and delivery.
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
`event_id`, optional `thread_id` and `reply_to_event_id`. These are provider
routing data, not host permission claims. The host maps verified SDK actors to
its own principals; another participant's message never inherits the owner.

`BridgeMessage` contains ordered `BridgePart` text/media and separately
attributed `history`. Slack/Discord history defaults to 20 messages, configurable
with `context_messages=0..100`, and has a hard 65,536-byte JSON budget including
attribution. Only the same authorized channel/thread is read. Trigger duplicates
are excluded, records are chronological, and oversized records are omitted.
Slack thread history inspects at most ten pages; if the latest window cannot be
reached within that cap, it omits history rather than returning an old prefix.
History is untrusted quoted data and cannot grant permission or replace the
current author. Replies retain the originating channel/thread.

Host integrations must revalidate output audience for shared channels, including
tool results and memory reads. Sharing an agent's memory does not make all of its
private knowledge visible to every channel member. Persistent learning follows
the same host policy and vault as other sessions, without a channel-only copy.
Contract v1 does not attest full group membership: hosts must deny group
delivery until they independently verify every result recipient.

Non-Python hosts can run `openagent-channel-bridge` as a binding-local child.
Its NDJSON protocol is `channel-bridge-ipc/v1`; `--describe` prints the contract
without starting a provider. Typed requests and responses preserve the same
transport authorization boundary. Media cross the pipe through bounded,
request-scoped readers/uploads and SHA-256, never a local filesystem path.

## Provider installation

Provider SDKs are optional extras. Low-level Slack Socket Mode accepts an
operator's existing bot and app-level credentials; this is an operator-managed
deployment option, not an end-user onboarding requirement. A user OAuth token
from the Slack MCP connector is not a channel bot token.

The shared official Slack member-bot setup requires a separately authorized bot
installation, channel event ingress and authenticated installation-to-host
routing. Existing connector public distribution alone does not establish those
capabilities. One shared app identity can support distinct user and bot grants;
the channel must not inherit connector permissions. Do not create duplicate apps
or require each user to register an app to conceal a missing hosted flow.

Real provider installation, OAuth consent and live model acceptance are separate
from SDK fixtures. See the qualification receipt accompanying each release for
the exact tested boundary.
