# Beta runbook: unified history, storage, search, and UI

Status: Active release train

Branch: `beta/unified-history-ui`

Release status: **beta prerelease authorized on 2026-08-26; stable is not authorized**

::: danger Authorization is beta-only and conditional on the gates
The explicit authorization covers implementation, Friday/Bluehost dogfood, and
GitHub prereleases for this train. It does not authorize a stable release, a
`latest` mutation, skipping a gate, reusing a tag, or publishing from a dirty or
unverified worktree. The server tag follows local gates plus the non-mutating
Friday preflight/backup rehearsal; the published server bytes are then the input
to Friday package E2E. App and CLI publication follows the Friday server gate.
:::

This runbook defines the active, gated beta release train for the work described in
the [unified history plan](../plans/unified-history-storage-search-beta.md) and
the [operational search threat model](../security/operational-search-threat-model.md).
The user authorization recorded on 2026-08-26 activates this runbook; every safety
and evidence requirement below still applies.

## 1. Objectives

The beta process must ensure that:

- server, app, and CLI can version and ship independently;
- the exact source SHA and exact package bytes tested are the ones published;
- a beta is an explicit opt-in GitHub prerelease and never becomes `latest`;
- stable installations never discover a beta;
- beta installations may advance to a newer eligible beta or stable release,
  but never downgrade ambiguously;
- server storage remains additive and rollback-safe throughout the beta;
- a failed binary or release can be withdrawn without reusing a tag or
  replacing assets in place;
- the first public mutation is made only after tests, package smoke tests,
  security gates, migration drills, and the already recorded beta authorization.

## 2. Repositories, branch, and observed baseline

All four repositories use the same branch name so the workstream is easy to
trace, but their versions remain independent.

| Repository | Branch | Version source | Stable/base integrated | Active candidate |
|---|---|---|---|---|
| `openagent-server` | `beta/unified-history-ui` | `pyproject.toml`, `src/__init__.py` | `v0.19.27` at `ea6acc52e2cb4b07e733075bc6469a6479e11cd1` | `0.20.0-beta.2` at `e0d60d210c219a7c974ce54f551877e96e67a287` |
| `openagent-app` | `beta/unified-history-ui` | `desktop/package.json`, `universal/package.json` | `0.16.0` at `cc6a45b6a31aa61087839c950596db0c18bc70c7` | `0.17.0-beta.1` |
| `openagent-cli` | `beta/unified-history-ui` | `pyproject.toml`, `src/__init__.py`, `src/openagent_cli/__init__.py` | `0.15.1` plus the post-release main fix at `58b236ab2cd6f8662036351ace9c2ee972bb2d17` | `0.16.0-beta.1` |
| `openagent-docs` | `beta/unified-history-ui` | no product package | `356f80003015c0a5e56a300b6477c12418af398f` | n/a |

Stable moved first to `v0.19.26` and then to `v0.19.27` during candidate
preparation. The active server candidate was reviewed and rebased onto
`ea6acc52e2cb4b07e733075bc6469a6479e11cd1`; its complete local suite passed
with `1645` tests, `0` failures and `46` skips, and branch test run
`32971003072` plus supply-chain run `32971003054` passed on the same frozen SHA
`e0d60d210c219a7c974ce54f551877e96e67a287`. The failed Beta 1 provenance is
retained in `release/unified-history-beta-1-intent.yaml`; the active frozen
candidate is recorded separately in `release/unified-history-beta-2-intent.yaml`.
Never substitute a moving branch name for those SHAs.

Changes from `origin/main` are integrated into each beta branch through a
reviewed merge or rebase before candidate freeze. A candidate is never built
from an outdated local `main`, a dirty worktree, or an unpushed commit.

## 3. Version model

### 3.1 Independent component versions

The train coordination identifier is `unified-history-beta.1`; each component
has its own approved Beta 1 release version and tag:

```text
train:  unified-history-beta.1
server: v0.20.0-beta.2
app:    v0.17.0-beta.1
cli:    v0.16.0-beta.1
```

These are the planned versions for this authorized train. If any immutable tag,
artifact, or hidden draft fails its gate, that version is burned and the fix
uses a monotonically newer `beta.N`; no tag or asset is replaced in place.

The server's `v0.20.0-beta.1` tag is the first recorded application of this
rule: release run `32969087557` stopped at the Windows package smoke because
Git Bash could not list a ZIP through `tar`. The release job was skipped, no
GitHub Release or assets were published, stable `latest` remained `v0.19.26`,
and the immutable tag was retained. The portable `zipfile` fix advances only
the server candidate to `v0.20.0-beta.2`; app and CLI remain Beta 1. Stable
subsequently advanced independently to `v0.19.27`, which was integrated and
fully re-tested before freezing Beta 2.

Rules:

- External tags use `vX.Y.Z-beta.N` and are never reused or moved.
- GitHub Release version and asset names use the same external SemVer string.
- App `package.json` versions use `X.Y.Z-beta.N`.
- Python package metadata uses the equivalent PEP 440 form, for example
  `X.Y.ZbN`, unless packaging tests prove an exact external spelling is
  preserved end to end.
- The manifest records both `release_version` and `package_version` when they
  differ.
- A release workflow derives asset names from the immutable external release
  version, not from normalized Python metadata.
- `beta.N` is monotonically increasing within a component's chosen base
  version. RC and stable promotion require separate explicit authorization.

This mapping is a blocker because Python normalizes `0.20.0-beta.2` to
`0.20.0b2`, while the current package scripts derive asset names from installed
metadata and the updater derives the expected name from the Git tag. The
release and updater tests must prove that tag, metadata, asset name, and version
comparison all agree.

### 3.2 Version consistency gate

Before candidate build, automated checks compare every declared version:

- server: `pyproject.toml` equals `src/__init__.py` after normalization;
- app: desktop and universal `package.json` values are identical;
- CLI: `pyproject.toml`, `src/__init__.py`, and
  `src/openagent_cli/__init__.py` agree after normalization;
- every package reports the expected version when executed from the packaged
  artifact, not only from a source checkout;
- the expected asset name selected by each updater exists exactly once.

## 4. Observed beta release-system state and remaining live gates

The beta worktrees contain the following release configuration as of
2026-08-26. “Implemented” describes reviewed workflow code; it is not evidence
that the tag workflow or published-package checks have already passed.

| Component | Implemented in the beta worktree | Remaining candidate evidence |
|---|---|---|
| Server workflow | Exact tag/source version gate; complete server suite; per-platform frozen build with the computer-control sidecar; final package checksum, extraction, exact `--version`, `selfcheck`, macOS signature/notarization checks; exact six-file release union; provenance attestation; hidden draft upload and GitHub digest verification before publication | Successful tagged matrix and Friday live-gateway/migration/rollback E2E using the exact Linux package digest |
| Server updater | Stable remains on `releases/latest`; explicit beta reads the release list, filters lineage/platform/version, verifies the exact asset and SHA-256, and retains pre-swap selfcheck, journal, `.old`, and boot guards | Stable/beta feed evidence and Friday channel cleanup; the first `0.19.x` to `0.20.0-beta.2` seed is manual by digest |
| App workflow | Exact dual-package version gate; `test.sh`; per-OS installers with mandatory macOS signing/notarization; extraction/install and executable launch smoke; update-metadata SHA-512/size checks; Apple Silicon plus Intel DMG/ZIP launch; exact merged asset union; provenance attestation; hidden draft digest gate | Successful tagged matrix plus real-gateway search/deep-link E2E and recovery evidence using the published stable `v0.16.0` installer |
| Electron updater | Stable stays on `latest`; a `-beta.N` build selects the isolated beta metadata and permits prereleases; beta updates remain manual rather than install-on-quit | Published metadata isolation and manual recovery check |
| CLI workflow | Exact three-source version gate; Python 3.12 unit/distribution gate; per-OS frozen launch; final package checksum, extraction, exact version/help probes; exact six-file release union; provenance attestation; hidden draft digest gate | Successful tagged matrix and Friday live-gateway history/search/JSON/pagination E2E using the exact Linux package digest |
| CLI updater | No local self-updater is advertised | Manual prerelease installation and rollback remain the Beta 1 procedure |

`scripts/release.sh` is excluded from this train. Pushing an immutable tag still
starts build and release preparation in one workflow, but no public prerelease
is exposed until every required job passes and the complete hidden draft has
been verified byte-for-byte. A failed tag or draft is superseded by a new
`beta.N`; it is never moved, reused, or repaired in place.

## 5. Roles and authority

One person may hold more than one role, but ownership and evidence remain
explicit. The user authorized this Beta 1 train on 2026-08-26; this runbook does
not invent an additional approver or tag-signature requirement.

- **Release coordinator:** selects the train, freezes SHAs, and owns the
  manifest.
- **Component owner:** confirms version consistency, tests, package smoke, and
  known issues for one repository.
- **Storage reviewer:** verifies migration, backup/restore, downgrade, and
  reconciliation evidence.
- **Security reviewer:** verifies the threat-model gates, secret scan, and
  channel isolation tests.
- **Publisher:** pushes the frozen immutable beta tag after all pre-tag gates.
  The workflow is the only publisher: it may expose the prerelease only after
  its hidden-draft asset and digest gate succeeds.
- **Dogfood owner:** monitors the opt-in cohort and can invoke a stop condition.

The pre-tag freeze record contains the existing authorization reference,
timestamp, exact source SHAs/versions, and the intent digest. Workflow-generated
evidence records run/artifact IDs and remote GitHub asset digests. Evidence for
one candidate never applies to a rebuilt candidate or a different tag.

## 6. Release state machine

```text
draft
  -> pretag_verified
  -> tag_pushed
  -> artifacts_built
  -> artifacts_verified
  -> hidden_release_draft
  -> draft_digests_verified
  -> published_prerelease
  -> dogfood
  -> promoted | superseded | revoked
```

- The train-level beta authorization already exists; candidate evidence proves
  that a particular immutable SHA/tag satisfied the technical gates.
- `draft` and `pretag_verified` create no tag or GitHub Release.
- `tag_pushed` is the first public mutation and is allowed only for the frozen
  intent record.
- `artifacts_verified` means the exact workflow artifacts passed their
  platform package smoke and merged-set verifier; it does not mean a public
  GitHub Release exists.
- `hidden_release_draft` is an unpublished GitHub draft. Upload failure leaves
  no partially visible prerelease.
- `draft_digests_verified` means the authenticated GitHub API reports the exact
  expected asset-name union, sizes, and `sha256:` digests while `draft=true`.
- `published_prerelease` is a single draft-state transition to
  `draft=false`, `prerelease=true`, `make_latest=false`, followed by a metadata
  recheck. This is the first public GitHub Release state.
- Any byte, SHA, version, permission, migration, or release-note change after
  verification creates a new candidate and invalidates prior evidence.
- A revoked or superseded version is never repaired in place. A new version and
  tag are required.

Before tags are pushed, the work remains in `draft`; the actual state must be
updated in the evidence record as the workflow advances.

## 7. Candidate workflow

### 7.1 Non-mutating preflight

The coordinator records, for every repository:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git merge-base HEAD origin/main
```

Expected conditions:

- branch is `beta/unified-history-ui`;
- worktree is clean and all candidate commits exist on the remote beta branch;
- SHA is reviewed and fixed in the intent manifest;
- no tag points to that candidate version;
- component versions and external release versions pass the mapping gate;
- no current GitHub release or updater feed already uses those versions.

These checks are non-mutating. After component versions are reviewed and
committed on the beta branches, the publisher may push the unused beta tag only
when all pre-tag gates and the freeze record are complete.

### 7.2 Build and hidden-draft verification

The implemented workflow entry point is an exact `vX.Y.Z-beta.N` tag. Before it
is used, its job graph must:

1. check out the exact tag SHA, not a moving branch tip;
2. validate tag, source, and package versions;
3. run unit, integration, E2E, migration, security, and compatibility gates;
4. build, sign, and notarize where supported;
5. package once for every supported OS/architecture;
6. produce SHA-256 digests, signing/provenance evidence, and an artifact
   inventory;
7. smoke the final signed/packaged bytes on their native platform, outside any
   editable install or source import path, before upload as immutable workflow
   artifacts;
8. download those platform artifacts into the release job, merge them, and
   reject duplicate, missing, or unexpected filenames and checksum mismatches;
9. attest the exact release payloads and upload them with overwrite disabled to
   an unpublished GitHub draft;
10. read that draft through the authenticated GitHub API and compare the exact
    asset-name union, byte sizes, and every remote `sha256:` digest with the
    downloaded local files;
11. only after that comparison, patch the draft to
    `draft=false`, `prerelease=true`, `make_latest=false`, then re-read and
    verify the published state;
12. record source SHA, workflow run/artifact IDs, versions, filenames, sizes,
    digests, attestations, and package-smoke evidence.

The release job refuses any filename, size, signature, or digest mismatch and
never invokes a compiler or packager. If upload or draft verification fails,
the release stays unpublished and the tag/version is superseded rather than
reused. A later non-publishing candidate workflow and protected manual
promotion remain useful hardening, but the evidence must describe the
tag-triggered graph actually used.

### 7.3 Required component gates

Server:

- complete `scripts/test_openagent.sh` suite;
- normalized storage, dual-write fault injection, migrator-lock, backup/restore,
  old-binary downgrade/re-upgrade, ACL, search, and performance suites;
- updater checksum/digest, interrupted download, bad-version, `.old`, boot
  guard, channel selection, and packaged-binary tests;
- package smoke on macOS, Linux, and Windows. The configured final-package
  probes verify checksum and exact archive payload; launch `--version` and an
  isolated `selfcheck`; and additionally validate the signed/stapled macOS
  package. Gateway/history/search boot is exercised separately on Friday from
  the exact published Linux digest.

App:

- `bash test.sh` in the release workflow;
- store/API/cursor/capability fallback tests;
- Playwright/Electron E2E and visual/accessibility checks;
- package extraction/install and launch, mandatory macOS signature/notarization,
  exact ASAR/web payload,
  update-metadata checks, stable/beta isolation, interrupted update, and
  prior-installer recovery. The macOS lane must cover both Apple Silicon and
  Intel DMG/ZIP payloads; the exact real-gateway search/deep-link flow is a
  separate dogfood gate.

CLI:

- the configured Python 3.11/3.12 `unittest` matrix and the release workflow's
  Python 3.12 gate run non-zero tests;
- the tag test job runs `scripts/test-packaging.sh full`, and each OS build
  launches its just-built frozen binary after any signing, then verifies the
  final package checksum, extracts it, and asserts exact `--version`, top-level
  help, and `server-info` help before upload;
- history/search pagination, JSON schema, exit-code, cancellation, account
  clearing, explicit legacy fallback, and cross-version integration tests;
- packaged executable smoke on every platform, including checksum, extraction,
  exact version, top-level help, and `server-info` help;
- if self-update is included: digest/signature, pre-swap selfcheck, atomic swap,
  `.old`, boot guard, bad-version suppression, and channel-isolation tests.

Docs:

- plan, threat model, migration/operator guide, release notes, manifest schema,
  and known limitations match the candidate behavior;
- docs never claim `prefer_v2`, complete coverage, updater support, or rollback
  behavior that the candidate did not prove.

## 8. Release-train manifests

The train uses two canonical evidence records so it never claims
workflow/artifact evidence before those objects exist:

1. the **intent manifest** is frozen before any tag; it records exact
   source SHAs, unused tags, versions, contracts, expected artifact matrix, pre-tag
   gate digests, and the existing beta authorization reference;
2. the **evidence index** is finalized only after workflow artifacts pass smoke
   and the GitHub draft digest gate completes; it binds the intent digest and
   adds workflow run IDs, exact artifact metadata, attestations, draft/published
   API snapshots, and smoke evidence.

The intent is operator-controlled pre-tag input. The evidence index is an
append-only train record assembled from workflow outputs; it is not falsely
represented as an asset that was already inside the release whose publication
created that evidence. App per-platform release manifests are release assets;
server and CLI use their exact-set verifier output plus workflow/GitHub API
records.

The intent shape is:

```yaml
schema: 1
train_id: unified-history-beta.1
channel: beta
status: pretag_verified
created_at: 2026-08-26T00:00:00Z

components:
  server:
    repository: openagent-uno/openagent-server
    source_sha: <40-hex>
    tag: v0.20.0-beta.2
    release_version: 0.20.0-beta.2
    package_version: 0.20.0b2
    api_revision: 2
    capabilities:
      history: 2
      global_search: 1
      session_messages: 1
      detail_resolvers: 1
    storage:
      schema_min: <version>
      schema_max: <version>
      default_phase: shadow
    expected_artifacts:
      - platform: <os-architecture>
        filename: <exact expected filename>

  app:
    repository: openagent-uno/openagent-app
    source_sha: <40-hex>
    tag: v0.17.0-beta.1
    release_version: 0.17.0-beta.1
    package_version: 0.17.0-beta.1
    required_capabilities:
      history: 2
      global_search: 1
    expected_artifacts: []

  cli:
    repository: openagent-uno/openagent-cli
    source_sha: <40-hex>
    tag: v0.16.0-beta.1
    release_version: 0.16.0-beta.1
    package_version: 0.16.0b1
    expected_artifacts: []

compatibility:
  install_order: [server, app, cli]
  old_clients_supported: true
  new_clients_fallback_to_old_server: true
  legacy_storage_retained: true

authorization:
  scope: beta_prerelease_only
  recorded_at: 2026-08-26
  stable: false
```

Its digest is computed over the agreed canonical byte serialization and stored
outside the object itself, avoiding a self-referential hash. The listed
versions are the approved Beta 1 versions; a failed immutable candidate advances
to a new `beta.N` and receives a new intent.

After `draft_digests_verified`, the evidence index records the intent digest,
every workflow run/artifact ID, exact filename, size, local SHA-256, GitHub asset
digest, attestation reference, installed-package smoke result and environment,
test-report digests, compatibility results, known issues, and the post-publish
API verification. The coordinator signs or otherwise authenticates the final
serialization only if an actual signing mechanism is configured; otherwise the
Git commit, workflow identity, artifact attestation and recorded digest provide
the available provenance. It may be linked from release notes after
publication, but release assets are never mutated to retrofit it.

## 9. Approved tag and immutable publication

Tagging is allowed only when the intent is complete and every applicable pre-tag
gate passes for its digest and exact SHAs. The user's beta authorization is
already recorded; no additional tag signature or invented approval is assumed.
With the current tag-triggered workflow, publication is automated but visibility
remains gated by the hidden-draft digest check. The publisher and workflow
perform, in order:

1. Re-read the frozen intent manifest and verify its digest.
2. Confirm each source SHA/version is committed on the beta branch and every
   `vX.Y.Z-beta.N` tag is unused.
3. Create and push one immutable beta tag per released component, pointing
   exactly to that component SHA; sign it only if a real configured signing
   identity is available and recorded.
4. Let the workflow validate versions, run tests, build/sign once, smoke each
   final package on its native runner, then upload those bytes as workflow
   artifacts.
5. Let only the final release job download and verify the exact merged set, then
   upload those same bytes to an unpublished draft with overwrite disabled.
6. Verify the draft through the authenticated GitHub API: expected tag, exact
   filename union, size and `sha256:` digest for every asset, `draft=true`, and
   the intended prerelease flag.
7. Patch that verified draft once to `draft=false`, `prerelease=true`,
   `make_latest=false`; immediately re-read it and fail if any field or asset
   changed.
8. Verify a clean unauthenticated download, finish the evidence index, and
   verify stable `latest` plus the stable updater feed are unchanged.

The release job should use a protected environment when repository settings
provide it. The immutable frozen tag is the human-controlled boundary either
way. `scripts/release.sh` is not part of the beta procedure.

## 10. Updater channels

Channel selection is installation-scoped, explicit, and stable by default.
Joining a beta in one OpenAgent account must not silently enroll another server
installation or device.

| Installed channel | Eligible releases | Ineligible releases |
|---|---|---|
| `stable` | A strictly newer non-prerelease stable version | Every beta/RC, draft, revoked, malformed, unsigned, or wrong-repository release |
| `beta` | A strictly newer eligible beta in the configured lineage, or a strictly newer stable version | Older versions, unrelated prerelease lineages, revoked versions, malformed tags/assets |

This eligibility table applies only where an automatic updater exists. The
packaged/frozen server implements both rows. The CLI beta uses verified manual
installation because it has no local self-updater. Neither component infers
server beta enrollment from an account setting.

Common rules:

- no auto-enrollment;
- no implicit downgrade when leaving beta;
- opting out of beta waits for a stable version newer than the installed beta,
  unless the user performs an explicit manual rollback;
- pins, paused updates, bad-version records, architecture, and platform remain
  part of eligibility;
- the selected release must be a published GitHub Release from the expected
  repository, and every asset name/digest must match the manifest;
- a missing checksum/signature/provenance requirement fails closed;
- stable and beta feeds are tested separately on every OS;
- a manual “Check for updates” action follows the selected channel and cannot
  bypass its policy.

### 10.1 Server

The packaged/frozen server updater supports the beta channel. A stable install
still uses the expected repository's GitHub `releases/latest` endpoint and
rejects every prerelease by default. An installation opts in with
`auto_update.channel: beta` or, when that config key is absent,
`OPENAGENT_UPDATE_CHANNEL=beta`. The scheduled update task must still be
enabled separately; selecting a channel never enables it. An explicit config
value takes precedence over the environment, so a contradictory
`auto_update.channel: stable` is a failed beta preflight rather than an
environment override.

The beta path reads the expected repository's releases feed and selects only a
strictly newer, non-draft `-beta.N` on the installed major/minor line or a
strictly newer stable release. It rejects alpha/RC, malformed, older,
cross-lineage, missing-platform-asset, and locally bad-version candidates. An
unknown channel value falls back to stable, never beta. Download/apply then
fails closed unless the selected server/platform asset has a verifiable SHA-256
from the GitHub asset digest or sibling checksum; the candidate must pass a pre-swap
self-check before atomic replacement. The `.old` binary, pending-update
journal, boot guard, and storage-aware health/rollback evidence remain required.

With neither config nor environment set, a stable binary remains stable; an
already installed beta binary may derive `beta` from its own version. This is
not permission to seed an installation: the initial prerelease installation or
the explicit channel drop-in is the enrollment boundary. Non-frozen/pip
installations do not use this GitHub artifact selector and cannot claim this
automatic beta-channel behavior.

The same-line rule is intentional and controls the Friday seed. A running
`0.19.x` binary does **not** auto-select `0.20.0-beta.2`, even after the
installation opts into beta. The first Friday upgrade is therefore a manual,
offline service replacement from the exact published
`openagent-0.20.0-beta.2-linux-x64.tar.gz` bytes after both the sibling checksum
and GitHub `sha256:` asset digest match. Once that exact package is installed
and healthy, the beta channel may select only later eligible `0.20.0-beta.N`
releases (or a strictly newer stable) according to the normal updater policy.

### 10.2 Electron app

Installing an Electron artifact whose own version is `-beta.N` is the explicit
beta-1 opt-in: that build selects its beta channel and `allowPrerelease`; a
stable build remains on `latest` and rejects prereleases. Beta metadata/feed
files are separate by OS and cannot overwrite stable metadata. A persisted
Settings channel picker is optional future UX, not a claim about beta 1.

The first app beta must retain the published stable `v0.16.0` installer URL and
its available checksum/digest evidence, and document manual recovery to that
version. Verify platform signing where the stable artifact provides it; do not
assume a signature that was not checked. Automatic installation is not enabled
for beta until launch-crash recovery and app-data compatibility are proven.
A user-initiated “Check for Updates” may still offer “Restart Now” and install
the selected verified beta immediately; choosing “Later” must leave
install-on-quit disabled.

### 10.3 CLI

`/update` remains a remote command for the server. CLI self-update, if shipped,
is a separate local command and never opens the server database.

The safe first-beta default is manual installation from attested/checksummed
GitHub prerelease assets because no CLI self-updater currently exists. If a
self-updater is implemented, it must have stable default, explicit beta opt-in,
check-only mode, checksum/signature, pre-swap selfcheck, atomic replacement,
`.old`, boot guard, bad-version suppression, and the same eligibility rules as
the server. A reduced updater is deferred rather than shipped.

## 11. Staged rollout

### Beta 1: additive shadow

- Server ships schema, verified pre-DDL backup, legacy change journal, atomic
  dual-write, backfill, shadow comparison, ACL/search infrastructure, and
  storage diagnostics.
- Default storage phase is `shadow`; `prefer_v2` is not remotely enabled.
- Legacy endpoints and `sessions.runs` remain available.
- App and CLI use capability versions and fall back only on explicit
  unsupported/404, never on 401, timeout, or 5xx.
- Install order is server first, then app/CLI. Old clients must continue to work
  with the beta server; new clients must retain limited behavior on an old
  server.
- Enrollment is a small, explicit dogfood cohort with a verified local backup
  and a recorded rollback target.

### 11.1 Friday/Bluehost dogfood gate

`Friday` is the designated opt-in Bluehost-hosted dogfood installation. Public
docs record only this environment alias: host addresses, SSH users, key paths,
passwords, enrollment tickets, and device certificates stay in the operator's
secret store or a protected CI environment and are never copied into a manifest
or test log.

Before touching the installation, the dogfood owner records metadata-only
baseline evidence: active service units, installed stable component versions
and checksums, database schema/storage phase and size, free disk, rollback
binary/installers, and a canonical backup made through the SQLite Backup API or
`VACUUM INTO`. The backup must pass digest, `integrity_check`, manifest, and an
isolated restore rehearsal; copying only a live WAL-mode `.db` file is invalid.

During this train, the stable updater completed `0.19.16` → `0.19.26` while the
first preflight record was being assembled. Its SQLite backup was valid, but
the executable filename and `source_version` metadata were stale. The original
record remains immutable; the discrepancy and a second, coherent Backup API
snapshot with both rollback binaries are recorded additively in
`release/friday-preflight-correction-20260826.yaml`. Friday rollout uses only
the corrected snapshot as its rollback baseline.

For the published server-beta rollout, Friday opts in at the installation
boundary with a dedicated systemd drop-in for `openagent-friday.service` whose
only beta-channel setting is:

~~~ini
[Service]
Environment=OPENAGENT_UPDATE_CHANNEL=beta
~~~

Before activating it, capture the prior unit/drop-in state and prove that the
server is a packaged/frozen candidate, `auto_update.enabled` is intentionally
set for the rollout, and `auto_update.channel` is absent or also `beta` (that
config key wins over the environment). After `daemon-reload` and a controlled
restart, verify only the named variable in the live process; never dump the
whole environment into evidence. A pre-publication candidate rehearsal keeps
the real GitHub beta poll disabled and installs the exact staged candidate by
digest instead; it does not fabricate or mutate a feed.

Because Friday starts on `0.19.x` and the updater deliberately accepts beta
candidates only on the installed major/minor line, the published Beta 1 rollout
also uses a manual digest-pinned seed. With the service stopped and the verified
pre-DDL backup/restore rehearsal complete:

1. download the exact Linux x64 server package and sibling checksum from the
   `v0.20.0-beta.2` GitHub prerelease;
2. compare the local SHA-256 with both the checksum file and the authenticated
   GitHub asset `digest`, and record the workflow/source identity;
3. retain the current `0.19.x` executable as the explicit rollback binary, then
   replace only the resolved server executable and packaged sidecar targets;
4. enable the captured beta drop-in, reload the named unit, and start the
   service under `0.20.0-beta.2`;
5. verify exact version, selfcheck, health, `api_revision=2`, storage in
   `shadow`, and eventual history/search readiness before connecting app or CLI.

The updater is not used to cross the `0.19` → `0.20` boundary. After the seed,
the drop-in enrolls only that installation in future compatible `0.20` beta
updates.

Rollback stops the named service, restores the retained `0.19.x` binary and
sidecar, restores or removes that exact drop-in, reloads the unit, restarts the
service, and proves that the live process no longer has beta eligibility before
considering binary rollback complete. Leaving the drop-in behind is a failed
rollback. The migrated additive schema and legacy writes are reconciled on the
subsequent beta re-upgrade; a database snapshot is restored only for verified
canonical corruption. The CLI remains a separately verified manual asset
install.

The E2E identity is a newly created temporary principal plus a single-use,
short-lived enrollment ticket. It must not reuse a personal password or an old
personal device certificate. Test data uses unique synthetic markers and the
evidence bundle stores only the temporary principal's opaque identifier, expiry,
and cleanup result—not the ticket, query, transcript, or credentials.

Rollout order is server first in additive `shadow`, then the matching app and
CLI candidates. `prefer_v2` remains disabled. The Friday matrix verifies the
five scopes and nine targets under `api_revision=2`, `history=2`,
`global_search=1`, `session_messages=1`, and `detail_resolvers=1`; exact chat
message/tool anchors, correct workflow/scheduled/event root-or-run resolution,
legacy fallback, old-client compatibility, restart, backup, and binary rollback
are exercised with the temporary principal. A source/worktree run is useful
compatibility evidence but is not exact packaged-artifact evidence; the latter
comes from the workflow smoke described in §7 and must match by digest.

At the end, revoke the ticket and all temporary devices, remove the temporary
principal and its synthetic resources through narrowly scoped server-side
operations, prove that the stable personal principal was unchanged, and record
service/storage health. Never use a broad user-delete/logout command whose
target is ambiguous when several handles share an installation. Friday does not
create tags or GitHub Releases.

### Beta 2: guarded `prefer_v2`

`prefer_v2` is eligible only for sessions that are complete and shadow-verified
after:

- zero unexplained parity mismatch and zero lost/duplicate write;
- ACL, redaction, secret-scan, WebSocket, and agent-principal gates pass;
- backup/restore and old-binary downgrade/re-upgrade drills pass;
- contention, latency, disk, memory, WAL, outbox, and coverage gates pass;
- beta 1 rollback evidence is complete.

The feature flag is reversible per installation and per session completeness.
It is not a server-controlled remote kill switch that violates self-hosting.

### RC and stable

RC freezes storage semantics and accepts only blocker fixes. Stable promotion
requires a separate manifest and explicit authorization; it does not mutate beta assets or
tags. Legacy storage removal is excluded and requires a later destructive
migration after at least one stable cycle.

## 12. Rollback and withdrawal

### 12.1 Before rollback

Record:

- installed component versions and manifest digest;
- source/update channel and bad-version state;
- storage phase, schema range, writer epoch, migration checkpoint, parity and
  search coverage;
- current canonical backup path, manifest, integrity result, and artifact
  status;
- relevant metadata-only logs and failure class.

Take a new verified backup of the current canonical state before a manual
binary rollback when the database remains healthy. This preserves writes made
after the original pre-migration snapshot.

### 12.2 Server rollback

Distinguish two operations:

- **Logical rollback:** the same beta binary returns reads to `legacy` while
  continuing atomic dual-write. No snapshot restore is needed.
- **Binary downgrade:** boot the previous known-good binary after verifying its
  recorded digest/provenance. A pre-v2 binary writes legacy only; on re-upgrade,
  legacy triggers/writer epoch plus
  ID/hash comparison force `shadow` reconciliation before `prefer_v2`.

The server updater may restore `.old` after boot-guard failure, but it must
check the binary's `schema_min/schema_max` before starting secondary writers.
Snapshot restore is offline and reserved for canonical corruption. It discards
post-snapshot writes and therefore requires strong confirmation. Derived
indexes are never restored across canonical rollback; they are rebuilt.

### 12.3 App and CLI rollback

- App rollback uses the published stable `v0.16.0` installer, after verifying
  its recorded digest and any platform signature actually present, until an
  automatic launch-crash guard exists. Server-side data remains authoritative,
  and app local state must be backward-compatible or safely reset without
  deleting server data.
- CLI rollback uses the previous published stable `v0.15.1` package and its
  recorded digest. If self-update later ships,
  `.old` and bad-version suppression are mandatory.
- Rolling back app or CLI never authorizes direct edits to `openagent.db`.

### 12.4 Withdrawing a published beta

When a stop condition fires:

1. mark the version revoked in updater eligibility and stop new beta installs;
2. publish a concise warning and recovery path without leaking user data;
3. retain the original manifest, digests, and audit trail;
4. never replace an asset, move a tag, or republish different bytes under the
   same version;
5. issue a fixed, monotonically newer beta after all gates pass again.

A security incident may require unpublishing public assets, but the internal
audit record and original digests remain immutable. Deletion is not a substitute
for updater revocation.

## 13. Verification matrix

Before candidate freeze, and again against published metadata after future
promotion:

- old app -> new server;
- old CLI -> new server;
- new app/CLI -> old server;
- new app/CLI -> server in `legacy`, `shadow`, and guarded `prefer_v2`;
- beta.1 -> beta.2;
- beta -> a semantically newer stable;
- beta opt-out when no newer stable exists;
- stable feed with visible beta releases in the repository;
- checksum/signature mismatch, missing asset, interrupted download, wrong
  architecture, wrong repository, malformed tag, and revoked version;
- server boot failure and `.old` rollback;
- app launch failure and recovery with the published stable `v0.16.0` installer;
- downgrade/write/delete/retention/re-upgrade storage reconciliation;
- backup/restore with artifact hash verification and index rebuild;
- disconnected Internet with a reachable local server;
- disconnected or stopped server shown as client offline, not as zero results.

For every updater case record the selected release, rejected candidates and
reason codes. Do not log credentials, query content, session titles, or paths.

## 14. Stop conditions

Stop candidate promotion or dogfood immediately for:

- canonical/shadow mismatch, lost/duplicate write, or unhandled database lock;
- cross-tenant result, count, target, detail, cache, or WebSocket leak;
- raw secret in search/index/log/telemetry or an unsafe unknown-tool value;
- unverified backup/restore or failed downgrade reconciliation;
- false-complete search coverage or an incorrect deep link;
- stable updater discovery of any prerelease;
- digest, signature/provenance, version, tag, SHA, or manifest mismatch;
- package launch/boot guard failure without a proven rollback target;
- artifact rebuilt after candidate freeze;
- release workflow capable of publishing before required dependencies pass, or
  of publishing a beta as latest/non-prerelease.

The dogfood owner records the stop, affected manifest/version, evidence, and
recovery decision. Resumption requires a new candidate; prior technical evidence
is not reused, while the existing beta-only authorization remains in force.

## 15. Current authorization boundary

Allowed now:

- implement and review on `beta/unified-history-ui`;
- run isolated tests, non-publishing builds, migration/rollback drills, and the
  scoped Friday dogfood procedure;
- prepare versions, manifests, notes, and immutable beta artifacts;
- after all relevant gates are recorded, push the frozen `-beta.N` tag and let
  its workflow create a GitHub prerelease with `make_latest=false`.

Not authorized:

- any stable/RC promotion, `latest` mutation, package-registry publication,
  reused/moved tag, or release that skips a gate;
- running `scripts/release.sh` as the beta procedure;
- enrolling an installation or device that did not explicitly opt in;
- enabling `prefer_v2` on real user data.

This documentation update itself performs no commit, push, tag, release,
deployment, updater mutation, or Friday state change.

## 16. Assumptions and unresolved blockers

Assumptions:

- server, app, CLI, and docs remain on `beta/unified-history-ui` through
  candidate freeze and prerelease verification;
- product versions remain independent and compatibility is capability-based;
- the first server beta is additive and defaults to `shadow`;
- GitHub remains the publication host, with local/offline operation after
  installation;
- no component prerelease is required merely to keep train numbers aligned.

Remaining gates and first-train order:

1. Run the configured server tag matrix and retain its exact workflow artifact
   IDs, platform smoke output, attestation, and hidden-draft digest gate.
2. Using that published digest, perform Friday's manual
   `0.20.0-beta.2` seed, temporary-principal package E2E,
   `0.19.x` binary rollback/re-upgrade, and cleanup without secret/query leakage.
3. Only after the Friday server gate, run the configured app and CLI tag
   matrices and retain exact platform smoke, attestation, and hidden-draft
   verification evidence.
4. Record stable/beta feed isolation for server and app, including the Friday
   drop-in removal on rollback; keep CLI installation manual and do not
   advertise a local CLI self-updater.
5. Retain the published stable app `v0.16.0` installer, verify its available
   digest/signature evidence, and prove the documented manual recovery path.
6. Finalize the train evidence index, known limitations, retention/revocation
   ownership, and post-publication checks that stable `latest` is unchanged.

The API contract itself is aligned across the current server/app/CLI code at
five scopes, nine targets, `api_revision=2`, and
`definition_field_anchors=false`. This document does not mark runtime gates as
passed. Stable remains outside the authorization.
