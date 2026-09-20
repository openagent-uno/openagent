# Standalone runtime integration and qualification

The server owns native identity, directory resolution, capabilities, catalogs,
and provider configuration. It supplies a Runtime, SqliteRuntimeStore and
AgentExecutor over the existing operational database. Gateway chat/stream
adapters call the same Runtime; the transport may detach without deleting an
accepted run. A stable request ID reconciles a lost response. Explicit stop
addresses that exact run.

Native principals derive from verified certificates. The identity adapter
retains both canonical PrincipalRef keys and the existing typed ACL aliases.
Unresolvable historical authors remain unresolved. Current network membership,
device epochs and session ACL recipients are checked again before publication.
History search intersects every recipient's ACL before pagination. Vault and
vault quality diagnostics are private to the registered agent owner unless
`runtime_tool_audiences.vault: installation` explicitly shares that agent's
corpus with current network members; this setting does not merge agent vaults.

App dashboard capabilities require the authenticated WebSocket registration
and the exact `app_connection_id` on a collaboration turn. Device tools also
require the exact capability instance and consent. The persistent dashboard
service does not advertise a global tool. CLI/channel turns and deferred
work do not inherit an unrelated App registration.

## Shared vault and audio services

Vault REST routes use the core's public `VaultAdministration`, including its
mutation lock, validation, derived indexes and Git provenance. A failed validator
never falls back to a direct file write. Vault change notifications recheck each
connected recipient's current identity and corpus policy before delivery.

REST and streaming voice use the public `VoiceService` and `VoiceSTT`/`VoiceTTS`
adapters. Cloud credentials and endpoints are supplied to an isolated audio
worker; unrelated process credentials and proxies cannot choose an account.
Native ElevenLabs token streaming retains its explicitly configured destination.
Local Whisper/Piper fallback is selected by the product and can be disabled via
`voice.local_fallback: false`. Cancellation propagates, the output declares its
actual audio encoding, and one utterance retains one selected model configuration.
Five focused product/core adapter tests passed; actual microphones and external
voice provider accounts remain separate qualification gates.

## Automation definition review

Definition writes through native REST and MCP share a transaction with their
revocable durable grants. The grant records the principal, exact definition
digest, audience and durable source scopes. Credential bearers and temporary
App/device leases are never persisted in the grant. Every occurrence resolves
and validates the current grant before Runtime admission or external effects.
DST scheduling and existing occurrence/request IDs remain in the current
scheduler and operational storage.

Historical definitions without a grant remain pending. An authorized owner
can inspect `GET /api/automations/{kind}/{id}/authorization` and approve that
exact returned digest with `POST` to the same path and JSON `{"digest":"…"}`.
Kinds are `scheduled_task`, `event` and `workflow`. A changed digest returns a
conflict. Disabling or changing a definition revokes the previous authority.
No startup path adopts the installation owner as an automation principal.

Pending, unclaimed deliveries may resume after explicit revision approval.
Previously running or claimed deliveries require reconciliation of their exact
run and possible external effects; they must not be requeued as new occurrences.
The revision review API is implemented; the App review workflow and a separately
scoped one-off grant for running a disabled definition remain to be qualified.

## Evidence and remaining gates

Tests run against clean wheels installed outside source package directories.
The installer verifies unique wheel import ownership; old setuptools build
folders cannot reintroduce deleted module copies. Deterministic tests cover
certificate binding, current revocation, per-user replay, catalog ownership,
atomic automation grants, App dashboard registration, background jobs, memory
ACL publication and isolation. The CLI regression suite passed 92 tests.
The final focused installed-product run passed 55 tests and 19 subtests;
the App collaboration reducer passed 19 tests, including trusted destination
and canonical run reconciliation.

The installed transport test runs a real Iroh server and clients, PAKE
registration for Alice and Bob, verified HTTP admission, persisted authorship,
cross-user replay rejection, and App WebSocket registration. Its model provider
is a local deterministic HTTP fixture; this is not a real external provider
qualification. The pinned Iroh 0.35 FFI emits an asyncio debug-thread callback
warning during test cleanup; aiohttp also reports inherited API deprecations.

The installed device test uses two independently enrolled accounts and two
real capability hosts. It verifies six filesystem, editor and shell effects
in temporary workspaces, exact source generation and ledger attribution,
cross-user instance rejection, missing-origin rejection, revocation between
discovery and invocation, and stale references after disconnect. Run it with
`python tests/verify_installed_device.py` from the installed-wheel environment.

The CLI terminal test launches the installed `openagent-cli` in a real PTY,
enrolls through PAKE, connects over Iroh, discovers tools, displays the fixture
answer and exits successfully. Its identity store and HOME are temporary;
the catalog does not inherit an unrelated App registration. Run it with
`python tests/verify_installed_cli.py`. Its compact result is recorded in
`artifacts/installed-cli-verification.json`.

The macOS arm64 App and its host-tool bundle were signed with the existing
Developer ID team, notarized and stapled. Gatekeeper accepts the resulting
App. Its actual packaged executable passed startup smoke and the full Electron
UI test (18.4 seconds on the final core12/product13 snapshot): account enrollment, device capability consent, filesystem writes and
reads over native Iroh, trusted destination rendering, and canonical history
after reload without duplicate messages or repeated effects. Archive and ASAR
digests are in `artifacts/packaged-macos-verification.json`. This isolated GUI
fixture uses Chromium's mock keychain so it neither creates nor accesses the
user's real keychain entries. The host-tools
bundle includes the compiled computer-control sidecar and the Chrome runtime;
the test only operates on its temporary filesystem fixture.

The product support extension retains all nine legacy regression modules and
their helper scripts. The support-only changes through legacy server v0.21.14
are ported into the product extension with their corpus and routing tests.
`python tests/verify_support.py` runs 235 deterministic cases through a real
Runtime and uniform capability catalog with recorded function doubles. The
migrated extension passes 200 and retains 35 already classified failures, with
identical failure-message SHA-256 values and no new failures. These inherited failures
are primarily older reply fixtures predating the human-voice review default.
`tests/support-baseline.json` pins that source and those exact failures;
`artifacts/support-regression-verification.json` records every result. A new
failure or changed failure message fails the driver. This is parity evidence,
not a claim that the inherited support suite is entirely green.

The three model-adapter replay entrypoints (`support_turn_replay`,
`support_resolution_replay` and `support_live_regression`) also enter a
temporary public Runtime before invoking their registered synthetic tools.
Two checks verify catalog dispatch and original exception propagation. Their
external model/guard adapters were not run during this qualification. The older
operational dry-run benchmark scripts are retained for historical comparison;
their private agent assembly has not been qualified as a v1 entrypoint.

The following release gates remain open until separately evidenced:

- Standalone browser and mobile interactive flows. macOS packaged App and
  the installed CLI have the authenticated fixture flows above.
- Real provider API/subscription accounts, audio devices, computer-control
  and Chrome actions. All model-loop evidence above uses a deterministic
  local HTTP provider; the two-account path is transport/API coverage.
- Other-platform installers and signatures. The complete macOS ARM64 updater
  transition is qualified below; equivalent platform chains remain open.
- Migration on authorized copies of real agent data, exact running-delivery
  reconciliation, and coordinated restore after post-migration writes.
- Qualified release manifests and immutable publication in the destination
  repositories. No release, deployment or persistent-agent cutover has occurred.

Server startup now requires a configured native network identity. An embedding
application constructs Core directly and supplies its own identity instead of
using an unauthenticated, owner-assuming native headless mode.

## Updater qualification

`artifacts/updater-chain-verification.json` records a complete native macOS
ARM64 Squirrel chain on an isolated copy:
`0.17.5 → 0.17.6 → 1.0.0 → 1.0.1`. Every archive matches its expected digest;
every installed result passes strict signature and Gatekeeper checks. The exact
public `v0.17.5` archive is the source, while the three destinations are signed,
notarized local release fixtures and remain unpublished.

The earlier timeout was in the acceptance test: it registered
`update-downloaded` on Electron's native updater while the download used the
separate `electron-updater` instance. The listener now uses the same instance
as `checkForUpdates` and `downloadUpdate`. Two complete runs pass in 1.9 and
1.7 minutes. The test also verifies that the source version, `Info.plist` and
`app.asar` remain unchanged. The installed user application was inspected
separately and remains valid, signed, notarized and unchanged. Platform-specific
updater chains outside macOS ARM64 remain open.
