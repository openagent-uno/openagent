# Channel history media and quiet delivery — component contract

Beta7 introduced this contract; beta8 adds cancellation safety and an explicit
history count capability. Immutable earlier releases are unchanged. This is not
a claim of live Slack/Discord acceptance. No provider account, model, release or
deployment is exercised by its deterministic fixtures.

Slack and Discord default to quiet delivery: one acknowledgement followed by
the final reply and its attachments. Explicit `delivery_mode: quiet` suppresses
tool messages, text deltas, editable status and compaction notices. Choose
`delivery_mode: live` to opt into progress. Do not combine `delivery_mode` with
the legacy `live` option; explicit `live: true` still opts into live delivery,
and explicit `live: false` preserves final-only compatibility. Standalone
explicit per-channel or environment live choices remain explicit choices.
The optional host-controlled `acknowledgement_text` replaces only the quiet
acknowledgement. It is a nonempty single line of at most 512 UTF-8 bytes. The
bridge does not infer a locale, inspect provider profiles or modify user text.

Quiet delivery does not guess where the final answer begins. The standalone
transport consumes the runtime's explicit `done.final_answer` object. The
legacy `done.text` and durable transcript remain complete. If the runtime has
not identified a final answer, quiet delivery says so and directs the reader
to the session instead of reposting accumulated narration. A host that already
returns `BridgeReply.parts` remains responsible for that final-result contract.

## Historical attachments

`BridgeCapabilities.history_media` is a boolean, false unless the host explicitly
supports ingestion. Each selected `history` record retains its original event,
speaker and timestamp. Ordered `parts` may contain text or the same attachment
DTO used for current input. On IPC that attachment carries a request-local
`reader_ref`, SHA-256 and ordinary metadata; it never carries a URL or path.
The existing `read_artifact` method and request lifetime apply unchanged.

The host ingests those readers through its ordinary current-actor, session-scoped
artifact service. Metadata remains quoted historical data, never a grant or a
different speaker's principal. Provider channel/thread selection, complete
fresh audience, mapped host permissions and revocation checks precede downloads,
transcription, ingestion and delivery. Historical audio uses the same configured
speech callback and keeps its original media beside the attributed transcript.

An optional `omitted_attachments` list contains safe metadata for unavailable
media: `kind`, `filename`, `mime_type`, `size_bytes`, `provider_attachment_id`
and `reason` (`unsupported`, `limit`, `unavailable` or `blocked`). Such a notice
is not a readable artifact. An older host receives these notices rather than
being told that a metadata-only file was made accessible.

Current media has priority. `BridgeCapabilities.history_max_files` defaults to
16. A host with `history_media: true` may advertise an integer from 16 to 64;
that count applies only to combined current/historical input for a selected
history request. Current-only inputs and output uploads stay bounded to 16.
Combined input remains limited to 64 MiB, with at most 32 MiB per historical
file and 256 total parts. The request-local registry expires on cancellation
and closes its pinned descriptors; its aggregate retained-byte bound remains
128 MiB. Raising the count does not raise any byte limit.
Only the selected newest context window is downloaded; the context is still
limited to 0–200 records and 64 KiB of attributed IPC metadata. Staging stays
inside the one provider request until host ingestion completes and is then
cleaned. Different events receive separate staging directories, including when
their original filenames match.

These bounds do not mean “all messages today.” There is no bridge-supplied
history pagination tool or implicit permission to use a provider connector.
If the task exceeds the configured window or file budget, omissions remain
explicit. Reading additional history requires a separately supported,
normally authorized capability; no broader search, channel fallback or token
alias is introduced by this contract.


## Beta9 admission and streaming authorization

Quiet Slack and Discord turns send their initial acknowledgement immediately
after provider-complete audience attestation and the host's current actor,
binding and delivery authorization. Downloads and transcription follow it.
An internal request-local flag prevents a second acknowledgement in dispatch;
legacy explicit live/final-only choices remain unchanged.

Media chunks reauthorize the host before and after IO. They do not refetch the
whole provider membership per 64 KiB. Provider checks remain before and after
files, before ordinary host ingestion and before each outward publication.
Slow transfers refresh their request-local provider proof after 10 seconds,
checking the original audience epoch; this proof is not a host grant and
never outlives the transfer closure. The host still authorizes each chunk.
Slack staged uploads recheck provider audience before external-file completion.
Discord outbound multipart publication retains its previous stricter checks.

A requested history fetch failure or incomplete bounded thread scan does not
become an empty-history run. The bridge emits an explicit error only through
fresh normal outbound authorization. With `context_messages: 0` no history is
requested. Authorization revocation never becomes a fallback response. A
speech callback TimeoutError/RuntimeError may yield the existing explicit
transcription-unavailable text only after fresh host and provider checks; the
original audio remains an input. PermissionError, rejected host grants, closed
transports and invalid attachment identities remain hard failures.

### Closed CLI diagnostic lines

Each diagnostic is at most 1024 UTF-8 bytes, including the literal ASCII prefix
`OA_CHANNEL_DIAGNOSTIC_V1 ` and a final newline. The following JSON object has
exactly these required keys (unknown, duplicate and null fields are invalid):

```json
{"schema_version":1,"provider":"slack","stage":"history","code":"completed","event_sha256":"<64 lowercase hexadecimal digits>","counters":{"files":38,"bytes":52968872,"transcriptions":4}}
```

Providers: slack, discord, telegram, whatsapp. Stages: admission, history,
transcription, submission, delivery, terminal. Codes: started, completed,
failed, authorization_denied, unavailable, cancelled. Counters contain exactly
`files` (integer 0–64), `bytes` (integer 0–67108864), `transcriptions` (integer 0–64);
booleans are not integers. The event hash is SHA-256 of the UTF-8 bytes
`oa-channel-diagnostic/v1\n` followed by compact ensure_ascii=False JSON of
`list(context.deduplication_key)`; JSON separators are comma and colon.

These observations are never grants or delivery receipts. They contain no
provider/host identifier, account, path, filename, URL, exception text, user
content or credential. Hosts must validate this closed schema, bind provider
to the owned process, enforce line/read/rate limits and discard all other
stderr. Never pass arbitrary stderr through to logs or users. Diagnostic
observer failure does not change the operation's authorization.

## Slow speech callbacks

The bridge passes a newly provider-verified audience context to every speech
callback and rechecks that same conversation epoch after it returns. Each
historical file retains the latest returned context; an earlier transcription
does not extend the life of its intake proof. The host still chooses its own
freshness window and rechecks ordinary actor and recipient authorization.
Revocation or a changed audience stops the turn rather than exposing a stale
transcript or continuing with a broader audience.

## Slack audio representations

For attested `audio/mp4` files named `.m4a`, Slack may serve a smaller MP4
representation than its original metadata size. A rendition is accepted only
with MP4 HTTP MIME and container signature and a positive, complete HTTP
Content-Length. Metadata still constrains the preflight budget; canonical
size and SHA always describe the actual bounded downloaded bytes. This
provider-specific rule does not relax generic file completeness, revocation
or audience-epoch checks. Missing provider files remain explicitly omitted.
