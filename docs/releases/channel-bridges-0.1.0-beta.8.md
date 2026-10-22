# Channel bridges 0.1.0 beta8

Canceled IPC requests can receive a late authorization response when a provider
stops consuming an upload body. The control reader now ignores responses only
for bounded, locally canceled, never-reused request IDs. It does not cache their
authority; unknown IDs and ordinary duplicate replies still fail closed.
Pinned input descriptors and request readers expire on cancellation.

Hosts can opt into `history_max_files` up to 64 only with `history_media`.
Default and current-only input counts remain 16, output remains 16, input bytes
remain 64 MiB, each file stays at most 32 MiB and retained artifacts at most
128 MiB. A deterministic Slack fixture keeps 38 historical files and ordinary
standalone CAS fixtures ingest and read back both 1 and 38 files. No unbounded
history pagination, provider grant, live model or Slack/Discord E2E is claimed.

Source qualification: 237 tests and 84 subcases, plus four standalone fixtures.
Public artifact qualification is recorded separately after normal installation.
Core remains an independent compatible dependency (minimum beta24).
