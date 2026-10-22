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
limited to 0–100 records and 64 KiB of attributed IPC metadata. Staging stays
inside the one provider request until host ingestion completes and is then
cleaned. Different events receive separate staging directories, including when
their original filenames match.

These bounds do not mean “all messages today.” There is no bridge-supplied
history pagination tool or implicit permission to use a provider connector.
If the task exceeds the configured window or file budget, omissions remain
explicit. Reading additional history requires a separately supported,
normally authorized capability; no broader search, channel fallback or token
alias is introduced by this contract.
