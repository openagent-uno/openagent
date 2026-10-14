# Connector release and qualification status

Status recorded on **14 October 2026**. This page distinguishes implemented
code, published artifacts, deployed services and real provider acceptance.
A visible card or a passing health check alone does not make a connector ready
for production. It is a qualification checkpoint, not a promise that an older
installed client already includes the candidate UI.

## Delivery checkpoint

| Surface | Confirmed | Still required |
| --- | --- | --- |
| Shared Go connector module | Published `0.1.3`; ten implemented integrations, two unavailable placeholders; preserved IDs/tool contracts | Continue versioned adapter compatibility and release qualification |
| Runner and Python/MCP adapter | Published checksum/manifest prerelease for six OS/architecture targets; public acquisition verified | Native Windows/Linux/macOS runtime and signing acceptance |
| Standalone server/CLI | Published `1.1.0-beta.39`; normal installed-product qualification with Core beta 22, connector runner/adapter `0.1.3` and Host Tools B6; catalog fixture verifies 12 official entries plus one custom MCP | Real provider consent and API operations; receiving hosts qualify their own rollout |
| Core privacy services | Published Core beta 22; installed-wheel qualification for a fresh canonical text-history cohort | Historical content, media, Vault/files and custom callbacks need qualified host coverage |
| Host Tools | Published `1.0.0b6` from canonical source; six native targets qualified, both macOS bundles signed and notarized | Windows Authenticode is not claimed; Linux ARM64 browser navigation is outside the recorded checks |
| Standalone App | Published `1.1.0-beta.17` for six macOS/Windows/Linux targets; macOS ARM64 and Intel are signed and notarized; real Linux x64 marketplace GUI acceptance with server beta 39 | Real provider consent and API operations; Mac/Windows marketplace GUI acceptance and the earlier renderer-reload UX limitation below |
| Common authentication service | Auth-only `0.1.5` published and deployed from source `a5f81d65a0d7939473b30759276fa719272fda4a`; connector module/runner `0.1.3` published independently; isolated Linux restore and QA health verified; encrypted Secret storage retained | Provider exchange/rotation/privacy capacity qualification and public provider activation |
| Common provider enrollment | ClickUp enabled only for named, cryptographically allowlisted QA installations; public enrollment remains unavailable | Finish the real consent round trip and activation gates before public enrollment |

Host products qualify their own deployments and client distributions. Their
version pins, release receipts and private deployment inventories remain with
those operators; they are not part of the standalone product's release proof.
Common OAuth remains closed to the public, and actual ClickUp browser consent
is still blocked as described below.

The [connector prerelease](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.3)
is distinct from [standalone product downloads](../downloads.md).
The [remote qualification workflow](https://github.com/openagent-uno/openagent-tools/actions/runs/38450067001)
passed. The published `qualification.json` records race/vet and vulnerability
checks, normal isolated Python-wheel installation, nine provider-privacy schema
checks, macOS ARM64 runner/broker smoke and cross-compilation for the other targets; it does
not claim real provider access or final product acceptance.
Provider availability is reported by the authenticated server catalog, not
inferred from a downloaded binary or logo.

The [standalone server/CLI release](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.39)
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
is separate from the [current Linux x64 marketplace visual acceptance](https://github.com/openagent-uno/openagent/actions/runs/38513332981)
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

[Auth service 0.1.5](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.5)
is a separate deployment release. It does not replace connector module/runner
versions in already installed products or activate public enrollment. Publishing
Core beta 22 and server/CLI beta 39 does not migrate a receiving host or attest
its production privacy processing.

## Provider registration checkpoint

- **Google:** OpenAgent app/client, callbacks, test audience and the existing
  connector scope set are prepared. Gmail, Drive, Analytics Data and Analytics
  Admin APIs were individually enabled and verified. The app remains in Testing;
  applicable verification and security assessment are not complete.
- **ClickUp:** the existing provider registration is reused. Its old redirect
  was removed at the operator's request; ClickUp saved the common auth origin.
  The actual callback path still needs a real round-trip test. A disposable
  standalone server has started a recipient-bound transaction through its
  authenticated product API. Auth-only 0.1.5 is published and deployed, but
  the real Chrome consent POST still returns `ERR_BLOCKED_BY_CLIENT`. A read-only
  check showed the initial disclosure form and a pending transaction: approval
  was not recorded, and no provider grant or token exchange occurred. This verified
  fail-closed behavior, not a successful OAuth round trip. The disposable
  product connection is disconnected and disabled; public enrollment remains
  closed. Existing tokens were not revoked by this configuration change.
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
