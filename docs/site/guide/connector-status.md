# Connector release and qualification status

Status updated on **16 October 2026**. This page distinguishes implemented
code, published artifacts, deployed services and real provider acceptance.
A visible card or a passing health check alone does not make a connector ready
for production. It is a qualification checkpoint, not a promise that an older
installed client already includes the candidate UI.

**Subsequent candidate QA, 16 October:** the private GitHub candidate passed a
selected-repository lifecycle, and Notion passed consent to one empty private QA
page, read, reversible title write with exact cleanup, owner refresh, read after
a real server restart and local disconnect. Slack subsequently passed scoped
reads, an approved message create/read/delete with cleanup, owner refresh after
a recorded 503 and explicit recovery, a post-restart read and local disconnect;
its owned runtime was stopped. See
[ChatGPT app coverage](./chatgpt-apps.md) for receipts and limits. The shared SDK/runner 0.1.4 has since been independently qualified and published.
Server/CLI beta 40 now adopts the published library. App beta 18 is separately
published, with a recorded Linux x64 marketplace trial against server beta 40. Neither publication nor these private trials open public OAuth enrollment. They also do not qualify the
[multi-source application composition contracts](./application-composition.md).

## Delivery checkpoint

| Surface | Confirmed | Still required |
| --- | --- | --- |
| Shared Go connector module | Published `0.1.4`; fourteen implemented official adapters, plus the custom MCP descriptor; preserved IDs/tool contracts | Continue versioned adapter compatibility and release qualification |
| Runner and Python/MCP adapter | Published checksum/manifest prerelease for six OS/architecture targets; public acquisition and Linux x64 runner/broker smoke verified | Other native targets and signing acceptance remain separate |
| Standalone server/CLI | Published `1.1.0-beta.40`; normal installed-product qualification with Core beta 22, connector runner/adapter `0.1.4` and Host Tools B6; real runner catalog verifies 14 official entries plus one custom descriptor | Real provider consent and API operations; receiving hosts qualify their own rollout |
| Core privacy services | Published Core beta 22; installed-wheel qualification for a fresh canonical text-history cohort | Historical content, media, Vault/files and custom callbacks need qualified host coverage |
| Host Tools | Published `1.0.0b6` from canonical source; six native targets qualified, both macOS bundles signed and notarized | Windows Authenticode is not claimed; Linux ARM64 browser navigation is outside the recorded checks |
| Standalone App | Published `1.1.0-beta.18` for six macOS/Windows/Linux targets; macOS ARM64 and Intel are signed and notarized; real Linux x64 marketplace GUI acceptance with server beta 40 and 14 official entries | Real provider consent and API operations; Mac/Windows marketplace GUI acceptance and the earlier renderer-reload UX limitation below |
| Common authentication service | Auth-only `0.1.6` published; the QA deployment now uses the reviewed Slack refresh fix from source `e2d3336710dcbde0b2092f095d854b3b4fc6dec7`; connector module/runner `0.1.4` published independently; isolated Linux restore and QA health verified; encrypted Secret storage retained | Provider exchange/rotation/privacy capacity qualification and public provider activation |
| Common provider enrollment | Provider grants enabled only for named, cryptographically allowlisted QA installations; public enrollment remains unavailable | ClickUp real consent, read, reversible write, restart and disconnect passed; remaining activation gates apply before public enrollment |

Host products qualify their own deployments and client distributions. Their
version pins, release receipts and private deployment inventories remain with
those operators; they are not part of the standalone product's release proof.
Common OAuth remains closed to the public. ClickUp now has a successful real
browser consent and installed-product trial, as recorded below.

The [connector prerelease](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.4)
is distinct from [standalone product downloads](../downloads.md).
Its eleven assets were published from clean source
`709e6634edbf71c6d53711b01482a0509eb7bfa0`; all uploaded API digests and sizes
matched the qualified files, and the anonymous manifest download was verified.
Manifest SHA-256:
`b8aa9fec6f5fc495b13325ad5c2db0a6a7ed5f1b450ad484401bc31629e0fd41`.
The bounded serial Linux qualification passed race/vet, govulncheck, twelve
compiled binary checks, nine provider-privacy schema tests, normal isolated
Python-wheel installation, native Linux x64 runner/broker fixtures and the
public beta 39 host acquisition contract. Other native targets have
cross-compilation/checksum/toolchain coverage only. The published
`qualification.json` records scope and evidence hashes. These checks do not
establish real provider access or final product acceptance.
Provider availability is reported by the authenticated server catalog, not
inferred from a downloaded binary or logo.

The [current server/CLI release](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.40)
publishes twelve verified assets from clean canonical source
`a5623534956d0ff3b1ad0f4c926d1b4cc6040a98`.
Manifest SHA-256:
`8a0458ff6166c1f61bd089af1746ac55c3b466e53bca30398c7c65a0857aca0c`.
Only Framework and CLI wheels move to beta 40; seven unchanged product wheels
are byte-identical to beta 39, with 109 source files verified. Normal isolated
installation passed dependency checks for 154 packages, 100 installed
server/CLI tests, eight separately identified source acquisition tests, the
installed workflow-readiness regression and the public SDK 0.1.4 runner catalog.
The [release receipt](https://github.com/openagent-uno/openagent/blob/main/docs/releases/v1.1.0-beta.40.md)
also records the subsequent normal server-plus-CLI installer bootstrap on
CPython 3.11.14. Native App and real provider acceptance remain separate.

The preceding [server/CLI beta 39 release](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.39)
publishes 14 assets from source `7a4c7954566b443537248ef1627af79bfca09eba`.
All asset API digests/sizes and anonymous downloads were verified. Its manifest
SHA-256 is `772b455753fe99fd97165134ab9739d0d40ac1650f73c20018b1ac561a335c97`.
Its normal installed dependency closure uses public Core beta 22, connector
runner/adapter 0.1.3 and Host Tools B6 through public APIs. The server installer and service environment use a
product-local runner; users do not need a Go compiler or a manually configured
runner path. The connector release remains independently pinned and verified.
These packaging checks do not establish provider consent, API access or privacy
processing.

The [App beta 16 release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.16)
contains 36 verified assets for six targets. Ten CI jobs passed, including native
packaged launches, macOS signing/notarization, Intel ZIP/DMG launches and exact
post-upload checksum verification. The signing/updater executor remains the
historical App repository; its payload comes from canonical source
`721e90feb0e4ae3bb719e23cf5983e064464f782`. Existing updater identities are
preserved. The [App beta 17 release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.17)
is published from canonical source `0b00b5bde99fbbe5685f7906a7d1596c6e0d85fb`;
its [native qualification run](https://github.com/openagent-uno/openagent-app/actions/runs/38479698733)
is separate from the [historical Linux x64 marketplace visual acceptance](https://github.com/openagent-uno/openagent/actions/runs/38513332981)
with released server beta 39. The earlier App beta 16/server beta 38 management
checks remain historical evidence.
Canonical product source remains in this repository.

[Host Tools B6](https://github.com/openagent-uno/openagent/releases/tag/v1.0.0b6)
publishes 16 verified assets from source `aa8dafb3ef14066dbdaadbbf66bc9b3a00b801e0`.
Its release-index SHA-256 is
`a0f85b84e6d98f525c466126df7a5de9437d9628127607517a94f1b61b1889e0`.
The [six-target native run](https://github.com/openagent-uno/openagent/actions/runs/38457527270),
both successful [Mac signing/archive gates](https://github.com/openagent-uno/openagent-app/actions/runs/38467343111)
and [final assembly](https://github.com/openagent-uno/openagent-app/actions/runs/38471673047)
are recorded separately. Assembly reused the qualified signatures; the four
other native archives and Python wheel stayed byte-identical. No provider grant
or user-profile acceptance is inferred from publication.

[Auth service 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.6)
is a separate deployment release. It does not replace connector module/runner
versions in already installed products or activate public enrollment. Publishing
Core beta 22 and server/CLI beta 39 does not migrate a receiving host or attest
its production privacy processing.

## Provider registration checkpoint

- **Google:** OpenAgent app/client, callbacks, test audience and the existing
  connector scope set are prepared. Gmail, Drive, Analytics Data and Analytics
  Admin APIs were individually enabled and verified. The app remains in Testing;
  applicable verification and security assessment are not complete.
- **ClickUp:** the existing provider registration and credentials are reused.
  Its common callback completed a real browser round trip on 14 October with
  auth service 0.1.6. The disclosure response now preserves the browser's
  same-origin form `Origin`; provider navigation still uses `no-referrer`, and
  missing, null and incorrect origins remain rejected. No browser protection
  was disabled for this successful trial. The ordinary public server/CLI beta
  39 installed with Core beta 22, connector SDK/runner 0.1.3 and Host Tools B6
  received the result through its authenticated API and saved credentials
  locally encrypted. Authorized workflow capability calls read the selected
  workspace, created and deleted only a uniquely marked QA task, and read again
  after a full server restart. Local disconnect disabled the connection and
  the temporary server was stopped. No model was used. ClickUp access tokens
  do not expire, so refresh is not applicable to this provider. This proves
  that installed-product path; native App interaction, other receiving hosts
  and public enrollment are separate acceptance boundaries.
- **Shopify:** the original provider registration is retained, renamed
  **OpenAgent**, and its released version is Active. The common callback was
  added; existing page, scopes, secrets and legacy webhook endpoints were kept.
  This records the existing app's configuration, not a new review approval.
- **Postiz:** the authorized account setup is complete without a paid subscription.
  Its Developers screen initially contained no app. An **OpenAgent** registration
  now uses the common callback; credentials are staged in encrypted production
  Secret storage. Credential validation and rotation remain required before
  activation. The provider remains disabled and
  has no authorized product connections.
- **Token/account connectors:** no common OAuth app is needed. Product-local
  configuration is implemented; dummy-token tests do not validate a real account.

## What the tests establish

The [App beta 18 release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.18)
publishes 36 verified assets from canonical payload source
`a5623534956d0ff3b1ad0f4c926d1b4cc6040a98`. Its [native qualification run](https://github.com/openagent-uno/openagent-app/actions/runs/38955525864)
is separate from the [Linux x64 marketplace worker trial](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app18-server40-marketplace-2026-10-16.json).
The latter installed the public App beta 18 and server beta 40 artifacts without
a source overlay and joined through normal authenticated membership. It loaded
14 official entries alongside 30 real registry results.
The authenticated connections, official catalog and registry requests returned
HTTP 200; actual screenshots show one shared card grid and official logos.
The isolated Linux worker launched Electron with `--no-sandbox`; this is not sandbox/security acceptance. Its `--local-e2e` option isolated the temporary profile/updater only; authentication remained ordinary.
This qualifies marketplace presentation on Linux x64, not Mac/Windows
marketplace GUI acceptance or provider OAuth/API operations. Exact source,
artifact digests, execution flags and owned cleanup are recorded in the
[visual receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app18-server40-marketplace-2026-10-16.json).

The preceding run remains historical evidence:

The [released App beta 17/server beta 39 visual run](https://github.com/openagent-uno/openagent/actions/runs/38513332981)
passed from qualifier source `9178edf19ec610f079f7e351fd783a9710db62c1`.
It installed the public Linux x64 App and server artifacts without a source
overlay, joined through the ordinary UI/SRP/device-certificate/Iroh path and
loaded 12 official entries alongside 30 real registry results. The three native
management requests for connections, official catalog and registry search
returned HTTP 200. [Actual screenshots](./connectors.md#connect-and-disconnect)
show official icons and registry cards interleaved without an official tab,
label or divider. Owned client and staging cleanup completed.

This hosted GUI run used Electron `--no-sandbox`; it is marketplace presentation
acceptance, not sandbox/security acceptance. No model, provider API, OAuth grant,
personal profile or credential export was used. It does not establish Mac or
Windows marketplace GUI acceptance or repeat the earlier reload/management flow.

Shared Go race/vet and adapter tests cover operation compatibility, scopes,
pagination, permitted retry behavior, replay/recipient fences, Shopify
coordination/recovery and durable webhook retry/deduplication. Provider responses
in these tests are controlled fixtures.

Standalone storage/authorization and acquisition tests, CLI management tests,
TypeScript and full renderer exports passed. The released native App beta 16
used real Iroh device/network membership against a disposable beta 38 server. It displayed
12 catalog entries alongside 30 actual public-registry results. Gmail search
mixed the branded integration and registry MCPs in the same grid. Dummy Replio
save, Manage, disable, persisted disabled state after renderer reload and
disconnect passed; the disconnected tombstone was retained with tools disabled,
and fixture credential and nonce were cleared. These used a
synthetic key and do not establish real Replio API access.

A renderer reload directly on the marketplace can briefly display an HTML/JSON
parse error while the loopback API origin is restored. The observed native
window recovered without another action. A live loopback can resume even when
password remembering was disabled; this does not mean a password was persisted.
The existing real-Iroh chat reload test establishes eventual chat recovery,
but does not cover the initial marketplace/sidebar error. No recovery time is
promised; this remains a scoped UX limitation.

Independent Go consumers were exercised with isolated host fixtures, including
encrypted dummy-token persistence, restart and local removal. These development
checks do not establish real OAuth access, signed native host releases or final
same-source package qualification. Every receiving host retains its own release
and data-processing responsibilities.

A bounded outage regression against the published server beta 39 dependency
closure passed on Linux. With a simulated unavailable broker, a still-valid
near-expiry token continued to serve a read without changing saved credentials;
new consent failed, local privacy processing continued, and blocked encrypted
receipts were retained without delivery ACK. Provider and broker responses were
fixtures: this does not establish a real consent, renewal or provider operation.

Nineteen focused standalone storage/authorization checks also passed with the
verified 0.1.1 adapter after adding recovery guards. Missing-key credential and
privacy-event cases preserve encrypted records; restoring the original key
allows the credential to be read after restart.

Server/CLI beta 39 retains complete encrypted privacy receipts,
rejects conflicting duplicates and commits before delivery ACK. Late uninstall
notifications preserve credentials minted by a newer consent. Historical
payload-only receipts remain explicitly marked until matching broker redelivery;
startup does not invent missing occurrence metadata. The expanded 35-check
authorization/acquisition/receipt suite passed against published Core/SQLite
beta 20 and connector adapter 0.1.2. Those earlier checks did not qualify
historical content, Vault/files or media export/redaction.

[Core beta 22](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.22)
is published with 23 wheels and verified manifests/checksums. It tracks provider
origins before API execution, selective customer records in tool results,
derived session history, compaction and child sessions. The installed-wheel
qualification covers a fresh canonical text-history cohort. Published standalone
beta 39 passed normal installed-product privacy tests and an exact catalog
follow-up against public runner 0.1.3: 12 official entries plus one custom MCP.
Privacy is strict opt-in via `connectors.privacy.enabled=true`. Coverage is
computed from the admitted canonical engine/provider, canonical dashboard
content validator, baseline history audit and public sinks installed before
startup/recovery/source registration; configuration cannot assert
`covered_surfaces`. Historical content, media, Vault/files and unqualified
callbacks remain blocked. These public APIs and product checks do not establish
real-provider consent, two-server Shopify acceptance or a receiving host rollout.
Host bridges and durable runtime privacy jobs require each receiving product's
own qualification. Unverified historical content, backups or enabled surfaces
with no qualified processor keep requests blocked. Receiving a webhook,
removing a credential or finishing control-plane SQL actions never completes
those content jobs by itself.

The operator-approved infrastructure maintenance upgraded the control plane to
`v1.33.13+k3s2`, enabled and rotated secrets-at-rest encryption, and verified
the final restart. Both nodes are Ready. Broker Secret values were unchanged;
the current datastore record is encrypted and its protected backup was
integrity-checked. A real published-module client also verified HTTPS,
signed mailbox access, replay/unsigned rejection and the 120-request/minute
quota. The bounded four-client burst had p95 latency 299 ms and no unexpected
responses. This is bootstrap admission evidence; provider exchange, rotation
and privacy backlog load remain separate qualification.

## Remaining implementation and activation gates

1. Extend and qualify privacy coverage for each receiving host's enabled
   surfaces beyond the fresh canonical text-history cohort, including historical
   content, Vault/files, media and custom callbacks. Unqualified surfaces keep
   processing blocked. Common Shopify remains disabled until real acceptance
   and the host's processing gates pass.
2. Finish provider exchange/rotation/privacy capacity qualification and the
   production request budget beyond the verified bootstrap mailbox quota.
   Encrypted production app-secret storage and matching backups are now
   verified. Bootstrap health is not the availability gate for a loaded
   production service.
3. Finish provider review/verification and test Google, ClickUp, Shopify and
   Postiz using their real callback/consent flows. Complete real cancel, read,
   authorized write, renewal, restart and local disconnection in all products.
4. Activate the central Shopify webhook path only after the legacy compatibility
   delivery and each product's local privacy processing are tested, including
   duplicate notifications and offline recipients.
5. Test two real servers on one Shopify shop: simultaneous acquisition/refresh,
   offline peer, expired/lost envelope, recovery and fresh consent. Coordinate
   any remaining legacy app-token issuers during the transition.
6. Build, sign and qualify supported product releases, preserve existing IDs,
   credentials and update paths, then opt receiving products into the qualified
   common app registrations. Migrate old connections through explicit consent.

Google's [restricted-scope rules](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
still apply when data is stored or transmitted by product servers; avoiding a
central content archive does not by itself remove verification/assessment
requirements. Shopify's [privacy requirements](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
require product actions in addition to receiving notifications.

## Architectural limits beyond the first rollout

The broker is intentionally a single writer. Multi-replica operation requires
transactional persistence and distributed rotation coordination. UI code remains
host-owned; provider marks are verified local assets packaged by clients.
Third-party protocol access does not automatically approve a product. Those
limits must remain explicit when embedding or extending the shared components.

The [operator guide](./connector-operations.md) describes configuration and
failure recovery. Update this checkpoint when a gate gains concrete evidence;
do not replace an untested boundary with a claim inferred from another layer.
