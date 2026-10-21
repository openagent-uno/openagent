# channel-bridge-ipc/v1

One child process owns one provider binding. All frames are UTF-8 NDJSON with
`protocol: "channel-bridge-ipc/v1"`. Lines are limited to 2 MiB. Request IDs are
bounded printable ASCII strings. Unknown fields, duplicate JSON keys, NaN,
unsupported versions and unsolicited replies fail closed. stdout is exclusively
the protocol; SDK logging and ordinary diagnostics use stderr.

The parent's first frame is:

```json
{"protocol":"channel-bridge-ipc/v1","type":"configure","request_id":"host-config","provider":"slack","binding_id":"binding-id","config":{"bot_token":"<secret-store-value>","app_token":"<operator-socket-mode-secret>","allowed_users":["Uallowed"],"context_messages":20}}
```

Use private inherited pipes. Never put credentials on argv, in logs or in a
model prompt. The example is operator-managed Socket Mode, not shared bot OAuth
onboarding. A `configured` reply means the configuration was accepted; it does
**not** mean provider authentication, intake or real model acceptance succeeded.
The same process cannot be reconfigured as another binding.
`--describe` reports `package_version`, supported providers, methods and limits
without loading an SDK or opening intake. The `start` result below is the host's
capability advertisement, not a provider-connected or live-delivery receipt.

The child emits:

```json
{"protocol":"channel-bridge-ipc/v1","type":"request","request_id":"child-1","method":"start","params":null}
```

The parent responds with the same request ID:

```json
{"protocol":"channel-bridge-ipc/v1","type":"result","request_id":"child-1","result":{"api_version":1,"commands":[],"input_media":[],"output_media":[],"progress_kinds":[]}}
```

Methods are `start`, `stop`, `authorize_context`, `authorize_delivery`, `send`,
`command`, `transcribe` and `synthesize`, using the public dataclasses. Both
authorization methods return an actual JSON boolean, not a truthy object or
`0`/`1`. `stop` returns null. The parent may
return `{"type":"error","request_id":"child-1","error":{"code":"denied"}}`
with the protocol field; error messages/bodies are not accepted. Progress is a
correlated `event` frame containing a `BridgeEvent` object in `event`. Progress
is ordered, may trigger nested authorization requests, and has bounded pending
work. At most 64 child requests are pending at once.

`BridgeContext` always comes from the authenticated provider adapter. The
protocol has no operation for injecting a provider event, replacing its actor,
or selecting an agent. The parent maps the immutable binding and real actor to
its usual run/session/identity APIs and current capabilities. `send` returns
`BridgeReply` with opaque host `session_ref` and `run_ref`; these are results,
not sender-selected routing authority.

## Actor admission and audience authorization

Beta 2 extends the same protocol and `api_version: 1` context with:

- `conversation_kind`: `unknown` (default), `direct`, `group`, `channel` or `thread`.
- `audience_ids`: distinct provider recipient IDs, empty by default, at most 1,000.
- `audience_complete`: a strict boolean, default `false`.
- `audience_verified_at`: finite nonnegative Unix seconds, or `null` by default.

These fields come from the authenticated provider adapter. The parent cannot
replace them through a result frame or an injected event. Actor admission uses
`authorize_context` before provider reads or host operations. Audience approval
uses a separate correlated `authorize_delivery` request whose `params` are the
same context with a freshly refreshed provider membership snapshot. The host
must apply its current binding, actor, tool, memory and recipient ACLs, reject
stale verification timestamps and approve every recipient. Provider membership
is not a host grant.

The bridge requires this approval before `send`/`command` can reach the host
model and before each outbound text, media or progress operation. Non-direct
contexts require a complete audience and an implemented `authorize_delivery`;
an older host that does not implement it must fail closed, not answer `true`
on the basis of actor-only admission. Unknown kinds are also non-direct.
Verified direct contexts retain the actor-only fallback for older in-process
transports. The IPC transport always emits `authorize_delivery`, so its host
must implement the correlated boolean response even for direct contexts.

Slack uses authenticated Web API membership, bounded to ten pages of 100
members, and verifies direct participants through channel metadata. Thread
audience means all channel recipients, not just authors of recent replies.
Insufficient provider scopes, incomplete pagination or an API failure prevents
group dispatch/delivery. Discord's optional `config.members_intent` is a strict
boolean and defaults to `false`; enabling it requests the SDK intent but does
not enable a provider grant. Guild channel audience uses fresh REST metadata,
current visibility permissions and a complete bounded member list. Discord
threads and group DMs remain incomplete and blocked. No partial cache or parent
channel list is accepted as proof for those contexts.

Hosts still provision provider permissions and map each recipient to their
ordinary authorization system. These protocol guarantees and SDK fixtures do
not claim a real installation, provider consent or live channel acceptance.

## Media

Input attachment metadata has `kind`, `filename`, `mime_type`, `size_bytes`,
optional `provider_attachment_id`, `sha256` and an opaque `reader_ref`.
`local_path` and `owned` never cross the wire. The stable provider identity and
digest are distinct from the temporary reader handle.

While the relevant child request is pending, the parent can send an artifact
RPC with a distinct `request_id` and the child's `parent_request_id`:

```json
{"protocol":"channel-bridge-ipc/v1","type":"request","request_id":"host-read-1","parent_request_id":"child-2","method":"read_artifact","params":{"reader_ref":"<opaque-ref>","offset":0,"length":65536}}
```

The result includes `data_base64`, `offset`, `reader_ref` and `eof`. Only that
active parent request can read the handle. Reads are capped at 64 KiB; files at
32 MiB. There are at most 16 artifacts per request and a 128 MiB process staging
budget. The host must ingest input bytes into its normal durable file service
before completing `send` or `transcribe`. Closing a request expires all its
reader references. File identity/size are checked; substituted paths are not
followed.

For output, use artifact RPC methods `upload_begin` with
`kind/filename/mime_type?/size_bytes/sha256`, then sequential `upload_chunk`
messages with `reader_ref/offset/data_base64`, then `upload_finish` with
`reader_ref`. The final size and SHA-256 must match. Reply media contain only
`{"reader_ref":"<completed-upload>"}` in their attachment field. Arbitrary
paths/URLs, incomplete uploads and another request's handles are rejected.
Owned staging is retained through delivery and cleaned when no longer needed.

EOF or invalid framing cancels this child binding and expires handles. It does
not stop the parent's runtime or automatically retry an uncertain provider
write or accepted run. Durable event/run idempotency remains host-owned.


Telegram private conversations are verified through the authenticated SDK bot
and a fresh `get_chat` result matching the actual actor. Telegram groups cannot
provide a complete audience through the Bot API and remain denied. WhatsApp
currently leaves the conversation kind unknown and audience incomplete; typed
runtime dispatch and result delivery remain denied until an authenticated
recipient proof is implemented. These limits also apply to the typed standalone
adapter; the historical untyped compatibility API does not attest audiences.
