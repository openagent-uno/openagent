# OpenAgent App v1.1.0-beta.32

The chat places tool cards where the agent first called each tool, between the
text before and after the call. A late result updates the original card.
Parallel calls keep their observed order even when their timestamps match.

Use Server beta 20 with this App for the full fix, including replies whose
final text trims whitespace. The layout survives reconciliation with matching
canonical history while the live turn is available. History without positions
keeps its stored order.

The Electron regression checks the actual order of the assistant text, tool
card and continuation in the transcript. Shared tests also cover multiple
calls at one boundary, late results, canonical tool identity and rich parts.
See the [native qualification receipt](../qualification/app32-native-release-2026-11-08.json).
