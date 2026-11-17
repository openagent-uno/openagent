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
