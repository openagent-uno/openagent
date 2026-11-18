# App beta67 — load durable history behind an empty live snapshot

An early empty collaboration snapshot is not a complete durable transcript.
When history discovery finishes, the active conversation now loads its canonical
page even if that snapshot arrived first. Live messages, local drafts and the
once-per-connection load fence are preserved. Explicit legacy servers retain
their declared loader.

Regression coverage exercises empty snapshots both before capability discovery
and on reconnect. Installed real-session opening and signed native publication
remain separate acceptance gates.

TypeScript and 260 common tests passed. Provider management (both account
contracts), delayed enrichment/focus, deferred tool authorization/reopening and
recovery after missed terminal frames each passed twice in Electron (ten
passes). The candidate renderer opened one real canonical conversation six
times, retaining its 60 messages and 55 linked tools without a legacy read.
The installed native App is a separate acceptance gate. The mutable update
channel was temporarily held at qualified beta65 after beta66 startup acceptance
found the empty-snapshot race; immutable artifacts and profiles are preserved.
