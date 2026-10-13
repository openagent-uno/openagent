# Connector release and qualification status

Status recorded on **13 October 2026**. This page distinguishes implemented
code, published artifacts, deployed services and real provider acceptance.
A visible card or a passing health check alone does not make a connector ready
for production. It is a qualification checkpoint, not a promise that an older
installed client already includes the candidate UI.

## Delivery checkpoint

| Surface | Confirmed | Still required |
| --- | --- | --- |
| Shared Go connector module | Published `0.1.2`; ten implemented integrations, two unavailable placeholders; preserved IDs/tool contracts | Continue versioned adapter compatibility and release qualification |
| Runner and Python/MCP adapter | Published checksum/manifest prerelease for six OS/architecture targets; public acquisition verified | Native Windows/Linux/macOS runtime and signing acceptance |
| Standalone server/CLI | Published `1.1.0-beta.38`; the public installer verifies the wheel closure and acquires runner `0.1.2` automatically; an installed authenticated server and CLI expose all 12 catalog entries | Real provider consent and API operations |
| Standalone App | Published `1.1.0-beta.16` for six macOS/Windows/Linux targets; macOS ARM64 and Intel are signed and notarized; released native App tested through real Iroh against server beta 38 with mixed marketplace cards | Real provider consent and API operations; initial renderer-reload UX limitation below |
| GlassPalace | Shared module `0.1.2` deployed in production; three control-plane replicas Ready; authenticated marketplace UI verified; existing ClickUp connection preserved | Signed native `0.1.81` delivery/qualification in progress and real common-provider acceptance |
| ICS | Shared module pinned; native supervisor forwards explicit opt-in; real local native login, catalog and encrypted dummy-token connection/reload verified | Windows Vault/Git NUL-handle fix and final package qualification before updated public server/client delivery; real provider acceptance |
| Common authentication service | Auth-only `0.1.3` published and deployed on Mixout from source `523d17efeb1de049ca20cf90b87c29f641879216`; module/runner remain independently pinned at `0.1.2`; encrypted Secret storage and signed admission checks verified | Provider exchange/rotation/privacy capacity qualification and public provider activation |
| Common provider enrollment | ClickUp enabled only for two named, cryptographically allowlisted QA installations; public enrollment remains unavailable | Finish the real consent round trip and activation gates before public enrollment |

The [connector prerelease](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.2)
is distinct from [standalone product downloads](../downloads.md).
[Tools qualification PR](https://github.com/openagent-uno/openagent-tools/pull/4)
and [GlassPalace release-gate PR](https://github.com/Viki-Home-AI/GlassPalace/pull/72)
are merged. The published `qualification.json` records contract qualification,
macOS runner smoke checks and cross-compilation for the other targets; it does
not claim real provider access or final product acceptance.
Provider availability is reported by the authenticated server catalog, not
inferred from a downloaded binary or logo.

The [standalone server/CLI release](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.38)
includes installed-wheel qualification and checksums. Its tested dependency
closure uses [public Core beta 21](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.21)
through public APIs. The server installer and service environment use a
product-local runner; users do not need a Go compiler or a manually configured
runner path. The connector release remains independently pinned and verified.
These packaging checks do not establish provider consent, API access or privacy
processing.

The [App beta 16 release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.16)
contains 36 verified assets for six targets. Ten CI jobs passed, including native
packaged launches, macOS signing/notarization, Intel ZIP/DMG launches and exact
post-upload checksum verification. The signing/updater executor remains the
historical App repository; its payload comes from canonical source
`721e90feb0e4ae3bb719e23cf5983e064464f782`. The historical repository is archived
again and existing updater identities are preserved.

[Auth service 0.1.3](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.3)
is a separate deployment release. It does not replace connector module/runner
0.1.2 or activate public enrollment. No candidate Core privacy API, product
privacy-job integration or related migration has been rolled into production.

## Provider registration checkpoint

- **Google:** OpenAgent app/client, callbacks, test audience and the existing
  connector scope set are prepared. Gmail, Drive, Analytics Data and Analytics
  Admin APIs were individually enabled and verified. The app remains in Testing;
  applicable verification and security assessment are not complete.
- **ClickUp:** the existing GlassPalace registration is reused. Its old redirect
  was removed at the operator's request; ClickUp saved the common auth origin.
  The actual callback path still needs a real round-trip test. A disposable
  standalone server has started a recipient-bound transaction through its
  authenticated product API. The auth-only 0.1.3 update is deployed; real
  provider callback, exchange and recipient delivery remain under qualification.
  Existing tokens were not revoked by this configuration change.
- **Shopify:** the original GlassPalace registration is retained, renamed
  **OpenAgent**, and its released version is Active. The common callback was
  added; existing page, scopes, secrets and legacy webhook endpoints were kept.
  This records the existing app's configuration, not a new review approval.
- **Postiz:** the reviewed common app registration is still pending.
- **Token/account connectors:** no common OAuth app is needed. Product-local
  configuration is implemented; dummy-token tests do not validate a real account.

## What the tests establish

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

ICS native development acceptance used a new local account, workspace and
server, not the user's installation. The encrypted Replio fixture persisted
a renderer reload. Local removal then revoked the fixture and cleared its
credential/nonce. After a complete private-server restart, the native client
kept its authenticated workspace and showed the catalog with no installed
connections. Both Go products' focused frontend suites passed 53 checks.
These ICS development checks do not establish real OAuth access, signed installed releases,
Windows/Linux native acceptance or completion of privacy actions.

Nineteen focused standalone storage/authorization checks also passed with the
verified 0.1.1 adapter after adding recovery guards. Missing-key credential and
privacy-event cases preserve encrypted records; restoring the original key
allows the credential to be read after restart.

The next standalone candidate retains complete encrypted privacy receipts,
rejects conflicting duplicates and commits before delivery ACK. Late uninstall
notifications preserve credentials minted by a newer consent. Historical
payload-only receipts remain explicitly marked until matching broker redelivery;
startup does not invent missing occurrence metadata. The expanded 35-check
authorization/acquisition/receipt suite passed against published Core/SQLite
beta 20 and connector adapter 0.1.2. Content export/redaction remains unfinished.

The upstream Core candidate tracks provider origins before API execution,
selective customer records in tool results, derived session history, compaction
and child sessions. Host bridges and durable runtime privacy jobs are candidates;
they have not yet been qualified with a final public Core/SQLite release in all
three products. Unverified historical content, backups or enabled surfaces with
no qualified processor keep the request blocked. Receiving a webhook, removing
a credential or finishing the control-plane SQL actions never completes those
content jobs by itself.

The operator-approved Mixout maintenance upgraded the control plane to
`v1.33.13+k3s2`, enabled and rotated secrets-at-rest encryption, and verified
the final restart. Both nodes are Ready. Broker Secret values were unchanged;
the current datastore record is encrypted and its protected backup was
integrity-checked. A real published-module client also verified HTTPS,
signed mailbox access, replay/unsigned rejection and the 120-request/minute
quota. The bounded four-client burst had p95 latency 299 ms and no unexpected
responses. This is bootstrap admission evidence; provider exchange, rotation
and privacy backlog load remain separate qualification.

## Remaining implementation and activation gates

1. Complete the standalone privacy-content processor: provenance of connected
   data, product-local export/redaction of derived history/Vault/files as
   applicable, durable processing/retry and completion receipts. Shopify remains
   blocked there until this is implemented and qualified.
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
