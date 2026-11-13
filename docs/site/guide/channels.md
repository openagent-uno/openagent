# Channels

All channels support text, images, files, voice, and video. The "is writing" indicator shows the agent is working, and — in [live mode](#live-messages) (on by default) — each tool call and each span of the answer is posted as its own chat message as the turn unfolds.

Core owns the shared command catalogue and semantics. Each host advertises its
supported scopes; instance administration commands appear only where supported.
`/new`, `/clear` and `/reset` stop current work and queued input, then start a
fresh conversation while keeping long-term memory and the vault. Hosts retaining
history keep the previous conversation readable. Shared conversations cannot be
reset by one member.

Hosts embedding their own runtime use the independently versioned
[official channel bridges](./embedded-channels.md), rather than installing the
standalone framework. Conversational channels and provider MCP connectors are
separate capabilities with separate grants.

## Telegram

```yaml
channels:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
    allowed_users: ["123456789", "987654321"]
```

Features: inline stop button, voice transcription (faster-whisper local or OpenAI Whisper API), markdown rendering via HTML parse mode.

The bridge registers the host's supported commands with Telegram's `/` picker.
For the session scope these are `/new`, `/clear`, `/stop`, `/status`, `/context`,
`/help`, `/compact` and `/model`; `/reset` and `/queue` are typed commands hidden
from the picker. `/new` requests inline confirmation and reports success only
after the host completes the reset. A host lacking command support reports that
the conversation was not reset.

From channel-bridges beta17, failed menu registration retries during healthy
polling after the provider backoff; a successful unchanged menu is not written
again. `RetryAfter` accepts both SDK duration representations. The menu describes
host capabilities, and its registration does not prove live reset acceptance.

## Discord

Discord, Slack and WhatsApp need their bridge SDK (`openagent-framework[discord]`,
`[slack]`, `[whatsapp]`). The frozen server is built with `[all]` and the source installer requests
them; for a manual wheel installation, install the matching extra. A configured
channel whose SDK is missing logs one startup error and is skipped.

```yaml
channels:
  discord:
    token: ${DISCORD_BOT_TOKEN}
    allowed_users:              # users allowed to DM/use slash commands
      - "123456789012345678"
    # allowed_guilds: []         # [] = any server
    listen_channels:             # all members may talk in these channels
      - "234567890123456789"
    # dm_only: false             # true = DMs only
    context_messages: 20         # prior messages, 0..100; hard 64 KiB budget
```

Discord has separate private and shared access boundaries. `allowed_users`
controls DMs and slash commands; `listen_channels` controls guild messages and
accepts every human member of each listed channel. An allowed DM user does not
bypass `listen_channels` elsewhere in the server. Configure at least one of
the two lists, or the bridge will not start. `allowed_guilds` can further
restrict which servers own the listed channels. Supports native slash commands
and an inline stop button.

## WhatsApp (Green API)

```yaml
channels:
  whatsapp:
    green_api_id: ${GREEN_API_ID}
    green_api_token: ${GREEN_API_TOKEN}
    allowed_users:
      - "391234567890"
```

No message editing and no inline buttons — users cancel with `/stop` text command.

## WebSocket (Desktop/Web App)

The desktop app and web app connect to the gateway over Iroh QUIC, authenticated by device certificates. No port configuration or shared tokens needed — the invite ticket carries the coordinator's NodeId, and the client dials directly via Iroh.

For development or custom clients, the loopback proxy exposes a local TCP endpoint:

```bash
# The loopback proxy bridges localhost to the agent over Iroh
openagent-cli proxy
```

This exposes `localhost:PORT` that acts as a plain HTTP/WS gateway, with the proxy handling Iroh transport and device cert presentation transparently.

## Webhook (inbound)

Every channel above is **outbound** — the agent dials out to a platform. The
webhook channel is the one **inbound** doorway: an external service (GitHub,
Stripe, Zapier, a CI job, a script — or a peer agent) calls a URL the agent
exposes and triggers work. It is the inbound analogue of the bridges.

```yaml
channels:
  webhook:
    enabled: true
    host: 0.0.0.0        # bind address (default 0.0.0.0)
    port: 8899           # TCP port for the /hooks/* listener
    public_url: https://hooks.example.com   # optional, shown in the UI
```

Unlike the other channels, the webhook is **not** a bridge — it is a dedicated
`aiohttp` listener the Gateway starts on its own port, serving **only**
`/hooks/{slug}`. The full `/api/*` gateway surface is structurally absent from
that port, so exposing it to the internet never leaks the management API. It is
**disabled by default**; no port opens until you set `enabled: true`.

What the webhook triggers is an **Event** — a first-class object with a name, a
webhook `type`, an input schema, a per-event secret, and a bound action (run a
workflow, fire a scheduled task, or start a chat session). Events are managed in
the app's **Events** screen, the CLI's `/events` menu, or by the agent through
the `events-manager` MCP. See [Events](./events.md) for the full model.

```bash
# Each event has its own path + secret:
curl -X POST https://hooks.example.com/hooks/github-push \
  -H 'X-OpenAgent-Event-Secret: whsec_…' \
  -H 'Content-Type: application/json' \
  -d '{"pusher": {"name": "ada"}}'
# → 202 {"delivery_id": "…", "status": "accepted"}
```

The listener binds a local port; expose it to callers with a reverse proxy or a
tunnel (and set `public_url` so the UI shows a complete address). Provider
presets (`github`, `stripe`, `slack`) additionally verify the sender's signature
over the raw body; `generic` / `generic-hmac` cover everything else.

## Running Multiple Channels

```bash
openagent serve                  # all configured channels
openagent serve -ch telegram     # specific channel only
```

## Live messages

By default every channel narrates a turn in the chat itself, the way Hermes does:

- the platform's **native "is writing" indicator** turns on where one exists (Telegram's typing dot, Discord's "Bot is typing…"); platforms without one (Slack, WhatsApp) simply lean on the step messages. There is no `Thinking…` placeholder message — the server reports reasoning as a boolean flag, never a chat bubble,
- each tool the agent uses is posted as its own message with a **friendly, human label** rather than the raw tool name — memory-vault work reads `🧠 Memorizing — <note>`, `📖 Recalling — <note>`, `🔍 Searching memory — "<query>"`, `🗑️ Forgetting — <note>`; a shell call reads `🔧 Running command`, a web search `🌐 Searching the web`, and a failure `⚠️ <label> failed: …`. The labels match the app's tool chips,
- each span of the assistant's text is posted as it is produced — the narration before a tool call, then the final answer — instead of one reply at the end.

The final message is never a duplicate: only the still-unposted tail of the answer is sent. This is one agent with many doorways (vision §9) — the same outbound stream the desktop app renders as a live transcript, mapped onto platform-native messages.

Turn it off per channel to get a single final reply per turn:

```yaml
channels:
  telegram:
    token: ${TELEGRAM_BOT_TOKEN}
    live: false        # one reply per turn; "is writing" indicator still shows
```

Or disable it fleet-wide with the `OPENAGENT_CHANNEL_LIVE=0` environment variable (a per-channel `live:` value still wins). Voice-note turns always use the single-reply path so a spoken question gets a spoken answer rather than a wall of intermediate text.

## Media Support

### Files & images from user → agent

Upload endpoint:

```
POST /api/upload        (multipart/form-data, field: "file")
```

Returns `{path, filename, transcription?}`. The `path` is a local absolute path the agent can read with the filesystem MCP (`filesystem_read_text_file`, `filesystem_read_media_file`, `filesystem_get_file_info`, etc.). On macOS it's a `/private/var/folders/.../T/oa_upload_<rand>/<filename>` realpath — already resolved so the filesystem MCP's allowlist check doesn't reject it.

Flow:

1. Client (web app, desktop, any bridge) posts the file to `/api/upload`.
2. The returned path goes into the next chat message text (e.g. `"Summarise the file at /private/var/.../report.pdf"`) — OR into the WS `attachments` field if the client builds one directly via `Agent.run(attachments=[...])`.
3. The LLM calls a filesystem MCP tool with that path to read content.

### Agent → user attachments

The agent signals attachments back to the client by emitting markers in its reply text:

```
[IMAGE:/path/to/chart.png]
[FILE:/path/to/report.pdf]
[VOICE:/path/to/memo.ogg]
[VIDEO:/path/to/clip.mp4]
```

The gateway strips these markers from the response text and delivers them as a structured `attachments: [{type, path, filename}]` array on the WS `response` message. Bridges render them as native media attachments (Telegram photo, Discord file, WhatsApp media).

## Voice Transcription

Voice messages are transcribed automatically. Two backends (tried in order):

1. **faster-whisper** (local, free, no API key) — install with `pip install openagent-framework[voice]`
2. **OpenAI Whisper API** (cloud fallback) — requires `OPENAI_API_KEY` in environment

## Bot profile synchronization

In the OpenAgent App, the owner can save a name and thumbnail under
**Settings → Agent Identity**. The standalone server normalizes the image to
a square JPEG and queues profile updates for configured bots. The settings
screen reports each provider's outcome. Save again to retry a rejected
update after correcting its settings or waiting for a rate limit to clear.
This changes the presentation of the configured bot; the OpenAgent network
handle and channel bindings stay the same.

- **Discord** uses the installed bot's profile API. Discord server nicknames
  can still take precedence over the bot name.
- **Telegram** uses the installed bot's default name and profile photo. Any
  separately configured localized names keep their precedence.
- **Slack** needs a dedicated app and an app configuration token with
  `app_configurations:read` and `app_configurations:write`; bot and socket
  tokens cannot manage its profile.
  Set `channels.slack.presentation_app_id` to that app's ID and
  `channels.slack.presentation_config_token` to a reference such as
  `${SLACK_PRESENTATION_CONFIG_TOKEN}`. The bot name and icon apply to the
  app's installations. To restore Slack's default icon, remove the uploaded
  icon in Slack app settings.
- Channels that do not expose a managed bot profile leave their provider
  identity unchanged.


## Editable live turns (beta23)

Live text turns use one editable main provider message for narration, tool
progress, compaction and the final answer. Each actual child session has one
separate editable message headed `Delegated to sub-agent`, with only its own
current operation and terminal outcome. Updates are coalesced into a bounded
latest-value mailbox and throttled across the turn; every send/edit retains
fresh audience and host authorization. An explicit provider rate-limit
rejection has at most two bounded retries. An uncertain initial send is never
blindly repeated. Final answers exceeding a provider's size limit use
continuation messages; files retain the normal attachment path. Quiet and
voice delivery keep their existing semantics.

Hosts may advertise `child` in `progress_kinds` and emit `BridgeEvent("child",
json_frame)` with exact `session_id`, `type` (`status`, `turn_complete`, `error`)
and optional `text`/terminal `reason`. Only the host's admitted child events may
be forwarded; stale events must not attach to a later turn. Hosts that do not
provide child events retain the main edited reply.

Telegram, WhatsApp, Slack and Discord implement the edit primitives. Provider
acceptance for this revision is tested separately; live QA is limited to
Telegram. Offline SDK fixtures do not establish live provider acceptance.
The [Telegram acceptance receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/telegram-turns-public-2026-11-12.json)
records the installed product beta33/Core beta81 checks, including outgoing
history, live child progress and a stopped turn followed immediately by a new
message. Other providers have no live acceptance claim in this receipt.


## Outgoing tool messages and conversation history

The standalone Telegram and WhatsApp messaging tools retain the provider's
native receipt and add `openagent_session` after an accepted private message.
The matching configured bot must attest the exact recipient, and the host
resolves its normal conversation and current network-user authorization. The
confirmed text is recorded as an assistant message through Core beta80; the
next reply can refer to it even when the send originated in a scheduled job.
No fake user turn or extra model run is created. If recording fails after
provider acceptance, the result explicitly reports `message_sent: true` and
`recorded: false` with a do-not-resend notice. Shared/group destinations without
a complete authorized mapping are not silently filed in a private session.


Canonical child runs in standalone stream channels are observed through the
public Runtime event service. The host forwards their own tool progress to
the child-tagged emitter while the parent is still running. Observation does
not execute a model, open a mutable stream session, or cancel a worker when
the observer detaches. Child/session/run lineage and read authorization are
checked before forwarding; parent completion drains bounded pending updates.

A channel input submitted immediately after an explicit stop waits for the
old collector's cancelled terminal boundary. It cannot become a follower of
the stopped reply or reuse that reply's provider message.

## Telegram command confirmation (beta24)

Confirming a command replaces its inline buttons with an execution indicator
before waiting for the host. Completion and failure are rendered as plain text,
so session identifiers and host diagnostics cannot invalidate Telegram Markdown
and leave an apparently unchanged confirmation. The host's completed status
remains mandatory for the success message. This presentation change does not
retry the command or grant additional permissions.
