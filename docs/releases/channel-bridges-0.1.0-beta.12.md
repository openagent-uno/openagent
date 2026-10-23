# Channel bridges beta12: negotiated complete history bytes

Hosts may opt into `history_max_bytes` from 65,536 through 262,144 bytes,
with the old 65,536-byte default retained. The same cap applies before and
after speech transcription. A byte or 256-part overflow now reports explicit
freshly authorized history unavailability and starts no partial agent task.
The existing 200-message window, 64-file opt-in, 64 MiB combined media input,
32 MiB per-file bound and request-local cleanup/authorization remain intact.
No message DTO, provider grant, Core version or new history tool is introduced.

Fifteen regressions fail on beta11 before the change. A synthetic 187-record,
19-voice history with long transcripts fits 256 KiB and retains every record,
audio file and transcript, while the legacy 64 KiB host explicitly rejects it.
The full source suite passes 298 tests and 86 subcases; it includes provider,
Base/IPC cap enforcement, Unicode attribution, parts overflow, revocation and
cleanup. These fixtures make no provider/model calls and do not qualify a live
business delegation. Installed public qualification is recorded separately.
