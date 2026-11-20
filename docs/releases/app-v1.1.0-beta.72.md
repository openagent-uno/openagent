# App beta72

A failed turn keeps its visible error when canonical user history arrives.
Previously, transcript reconciliation could replace a failed live turn with its
persisted user message alone, leaving the conversation without an answer or an
explanation. Repeated snapshots keep one error message, rather than duplicating
it. Existing successful replies, tool placement and account profiles are
preserved.

This is a client presentation fix for the existing collaboration state. It does
not add error prose to the model's stored conversation history. Server beta99
separately adopts shared Core model recovery; compatible earlier App versions
can use that server behavior.

The shared transcript regression, complete common suite (271 tests), and desktop
and mobile TypeScript checks passed on source. Native signed packaging, updater
acceptance and installed-device verification are separate release gates.
