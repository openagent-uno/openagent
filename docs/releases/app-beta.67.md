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

The official build and publisher subsequently passed for all six native targets.
The signed macOS arm64 package passed signature/Gatekeeper checks and was tested
with its existing authorized profile against a live Server beta87/Core beta137.
Six canonical history reloads retained all expected assistant/tool rows, linked
tool details opened and reopened, a bounded chat produced its expected answer
without tools, and the named subscription probe passed twice. The update feed
now advertises beta67. See the [paired visible-history measurements](../performance-2026-11-17.md#installed-remote-history-qualification--18-november)
for the scoped performance result and its limits.

## Follow-up source qualification — turn timestamps

A legacy transcript can supply epoch seconds while the day divider already
normalizes them to milliseconds. The follow-up renderer uses that same bounded
normalizer for turn times and their accessible date, preventing a modern message
from showing a 1970 date. The real Electron recovery fixture now supplies legacy
seconds and checks the accessible year alongside the existing tool, model-label
and reconnect assertions. Ten timeline tests and the Electron recovery scenario
passed locally. This follow-up is not yet in the signed beta67 artifact.
