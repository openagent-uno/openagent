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

The child emits:

```json
{"protocol":"channel-bridge-ipc/v1","type":"request","request_id":"child-1","method":"start","params":null}
```

The parent responds with the same request ID:

```json
{"protocol":"channel-bridge-ipc/v1","type":"result","request_id":"child-1","result":{"api_version":1,"commands":[],"input_media":[],"output_media":[],"progress_kinds":[]}}
```

Methods are `start`, `stop`, `authorize_context`, `send`, `command`, `transcribe`
and `synthesize`, using the public dataclasses. `authorize_context` returns an
actual JSON boolean, not a truthy object. `stop` returns null. The parent may
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
