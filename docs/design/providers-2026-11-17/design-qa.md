# Provider management design QA

The approved overview and the implemented 1440×1024 renderer were inspected in
one [combined comparison](comparison.png). The existing account rail, navigation
and Settings sections remain the surrounding application shell.

Verified in the running Electron app with deterministic account fixtures:

- Three provider cards per row at desktop width; independent API, Personal and
  Work subscription connections coexist under each vendor.
- Named account toggles affect the exact account; a sibling remains enabled.
- Expired sign-in, unreported quota and unavailable/absent usage are distinct.
  Available quota uses a progress bar and reset window; no usage is invented.
- Provider details expose text, image, speech and transcription as peer types.
  Model parameters follow the Core schema; credentials appear only in the
  connection form. Scoped and inherited budgets remain visible.
- API and subscription connect phases show the correct credential fields.
  A subscription asks for an account name and browser sign-in, not a proxy URL.
- At 390×844 the provider grid has one column and no horizontal page overflow.
- No renderer errors were observed in the completed provider flow. Account
  switching and existing device/session controls passed twice separately.

Evidence: `providers-grid-wide.png`, `providers-grid-narrow.png`,
`provider-models.png`, `model-settings.png`, `add-speech-model.png`,
`connection-budget.png`, `connect-api.png`, `connect-subscription.png`.
The generated references are design assets; their quota/cost examples are
illustrative, not source data. The implementation uses reported values only.

Visual result: pass for hierarchy, grouping, spacing, contrast, modal phases,
responsive layout and identity distinction. Real provider/OAuth acceptance and
signed distribution remain separate release gates.

## Installed-app follow-up, 18 November 2026

A signed, notarized beta 61 was installed over the existing desktop app without
replacing its profile. The live host connected and restored its conversation;
provider cards, nested models, model settings and shared/connection budgets
rendered. The actual Claude connection test succeeded. This walkthrough exposed
an API-account probe being mistaken for inference unreachability and retained
scroll offsets hiding provider headings after navigation.

Beta 62 ignores subscription-account probe failures for plain API connections,
resets the provider navigation scroll, clears stale action feedback on navigation,
and displays successful connection feedback with the success tone at the top.
Expired quota reset timestamps no longer render “Resets in now”. Model management
and cost forms remount at the current connection scope, preserving source isolation
during reconnects. No provider/model identifiers or user preferences are migrated.

Provider regression exercises API connections with no account endpoint, real
Electron navigation, independent account switches, typed model forms and budgets.
Installed beta 62 acceptance and release receipts must be recorded separately.
The initial session-opening 3x target remains unproven.

Local beta 62 follow-up gates: 269 common/component tests passed, the universal
TypeScript check passed, and the provider workflow plus agent-switching/loading
workflows each passed twice in Electron (6 runs total). Delayed-enrichment first
cards remained usable in 113–116 ms. These measurements are fixture-based and do
not establish a threefold improvement for production session opening.


## Installed beta 62 and compact-grid follow-up

The official signed and notarized beta 62 preserved the existing profile and
successfully replayed provider drill-in, a real connection test, return to the
overview (20 steps), and a new chat with a real subscription answer (8 steps).

The full-screen walkthrough exposed wasted columns when each vendor has only
one account. Beta 63 lays all connection cards into the same responsive grid;
account identity and the shared vendor-budget action remain inside each card.
Provider polling runs only while the owning route has focus. The delayed-quota
Electron regression advances 61 seconds of renderer timers after entering chat
and verifies that the retained Settings route performs no provider reads.
Connection-test failures retain their error notice instead of being cleared by
a successful catalog reload or shown with the success tone.

Local beta 63 gates: universal TypeScript check and 269 common/component tests
passed. Provider management and delayed-enrichment/focus tests each passed twice
in Electron. The workflow also verifies failed/successful test feedback survives
the subsequent catalog load, with no stale notice. First cards rendered in
122–123 ms with independently delayed account/quota data. These fixture results
do not establish the production session-opening target.

## App beta 64 — account policy and deferred tool inspection

The connection screen exposes automatic account fallback only when Core's
declared migration group exists. The switch changes group participation without
changing account enablement, model settings or the saved group identity.

A collapsed canonical tool card loads its authorized detail only when opened.
Every reopen rechecks access, clears the earlier detail while loading, and shows
a retryable error on refusal instead of retaining another result. Aborts and
agent/session boundaries fence late responses. Normal live tool payloads keep
their existing expansion behavior.

Universal TypeScript and 257 common tests passed. Provider management (including
the new policy switch), delayed enrichment/focus and deferred tool inspection
each passed twice in Electron: six complete runs. Detail checks cover deferred
loading, reopening after authorization refusal, error retry and unchanged chat
content. These fixtures are separate from native publication and live-host
acceptance. App beta 63 also passed actual provider connection and new-chat
checks against the Server beta 84 pilot.
