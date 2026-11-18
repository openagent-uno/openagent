# App beta66 — wait for the transcript contract during startup

A deep link or early live session metadata can arrive before capability discovery.
The transcript loader now waits for the authenticated server's declared history
format, then starts the active conversation automatically. It never treats an
unknown capability state as a legacy server. Explicit legacy servers retain their
existing loader. This also covers reconciliation before discovery completes.

Regression tests exercise early hydration, manual loading and reconciliation
before discovery, then both canonical and legacy resolution without duplicate
reads. Provider, typed model, budget and deferred tool behavior from beta65 is
retained. Native publication and live startup acceptance remain separate gates.

Local qualification: TypeScript and 259 common tests passed; provider management
with both account contracts, delayed enrichment/focus and deferred tool detail
inspection passed twice each in Electron (eight passes).
