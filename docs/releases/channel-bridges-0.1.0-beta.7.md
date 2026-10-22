# Channel bridges 0.1.0 beta7

Slack and Discord preserve media-only historical messages, their original
event/speaker attribution, and audio transcription through the normal configured
host callback. A host must advertise `history_media`; it then receives the same
request-scoped, SHA-256-checked attachment readers as for current input. Unsupported,
blocked, unavailable or over-budget media has explicit safe omission metadata.
Fresh complete audience and host authorization still precede reads and delivery.

The default delivery mode acknowledges once and publishes only the final host
reply. Explicit live delivery remains available, and the host can supply a
bounded single-line acknowledgement in its own language. No heuristic rewrites
assistant prose. Standalone authoritative Core final-answer consumption requires
its separately released runtime/client-transport/server family.

History remains latest-N (0–100), at most 64 KiB of metadata, 16 combined
current/historical files, 64 MiB combined media and 32 MiB per historical file.
This release does not introduce an all-day history paging tool or grant provider
connector access. Provider fixtures are not live Slack or Discord acceptance.

Versions, wheel/source digests, minimal normal installs and anonymous public
readback are recorded in separate immutable component receipts. No paid CI,
Electron App, frozen server binary or updater feed is part of this component.
