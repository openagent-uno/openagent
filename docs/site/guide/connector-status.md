# Connector release and qualification status

Status updated on **19 October 2026**. Current published Python components are
**SDK/runner 0.1.8 and server/CLI beta45**, with **114 official connectors plus
Custom MCP**, Core beta22 and Host Tools 1.0.0b6. This adds 90 token-based
connectors with two read tools each and read-only OneDrive/SharePoint.
**App beta22 is public** and App22/server45/SDK18 is the visually qualified
Linux x64 pair: 114 official cards and 30 registry results, with ten reviewed
screenshots. Historical App21/server44 receipts remain unchanged below. A card,
component release or health check does not establish provider access; each
boundary has its own evidence.

## Delivery checkpoint

| Component | Qualified delivery | Remaining boundary |
| --- | --- | --- |
| Shared Go module, runner and Python/MCP | SDK 0.1.8 public: 114 official connectors plus Custom MCP; canonical race/vet/vulnerability, cross-platform packaging and isolated Python/native qualification | Real-account acceptance for the 90 token profiles; Google/Microsoft real OAuth and API acceptance; native execution on every target |
| Server/CLI | Beta45 public from `0049bfd9`, Core22/SDK0.1.8/B6; 210 installed tests, 15 separate React component source scenarios and the normal public installer45 passed | Windows/macOS server execution and independent host rollout |
| Normal keyless workflows | Three connections and six reads across a real restart, followed by disconnect/tombstone/source removal and cleanup | Only Parallel fetch, Context7 query and CoinGecko global; workflow metrics do not expose provider HTTP attempt telemetry |
| Standalone App | Beta22 public, 36 verified assets/six native targets; signed/notarized macOS and Intel ZIP/DMG launches; actual App22/server45 Linux x64 marketplace, blank Postman setup and one local Exa cycle passed | Mac/Windows marketplace GUI, hosted sandbox security and native App provider operations |
| Core / Tools / Host Tools | Independently pinned public Core beta 22, Tools beta 4 and B6; unchanged component contracts and manifests | Component publication does not update an installed host or attest privacy coverage |
| Common authentication service | Reviewed `e2d33367` deployment; ClickUp/GitHub/Notion limited public beta, health/readiness and receiving-installation disclosure checks | Every new consent, further provider activation and loaded capacity qualification |

### Current Python release and the visually qualified pair

[Server/CLI45](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.45)
is public from `0049bfd95cf722784c835897ce6175a6690a1bc1`, adopting
[SDK 0.1.8](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.8)
and its 114 official entries plus Custom MCP. Its public release manifest is
`cab1b4dc4555f23fc22e5f9a9b32ba6618cebe1ada8404ebac85257b031eff3c`.
The installed qualification passed 210 installed tests and 15 separate React component source scenarios. These are
installed implementation fixtures, not new real-account provider trials.
The [normal public installer45](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product45-public-installer-2026-10-18.json) passed separate server/CLI installs, dependency checks, ORM and the 114-plus-Custom installed catalog. It started no server/model and made no provider calls. [App22 is public](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.22), with its [native release receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app22-native-release-2026-10-18.json) and a separate [App22/server45 Linux x64 GUI receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app22-server45-marketplace-2026-10-18.json). The GUI trial loaded 114 official cards and 30 registry results, verified 45 shared SVGs and 12 bundled marks, and produced ten visually reviewed screenshots. Blank Postman setup was cancelled, and one Exa local cycle completed. Google/Microsoft remained unavailable by default. Provider/model calls and new OAuth grants were zero; exact owned cleanup passed.

The 90 manual-token profiles expose two compiled reads each. Vendor permissions
remain setup requirements enforced by the provider; an API token does not
attest OAuth scopes. HTTP403 is a failure, not an empty successful read. Normal
host-token discovery/invocation and documented response fixtures do not prove
that an actual user account has the provider's required permissions.

OneDrive/SharePoint add five/seven read tools, with per-account identity,
explicit server-verified drive/site selection and bounded file reads. They add
no file writes, auto-provisioning or selected-permission fallback. Microsoft
common enrollment and real OAuth/file-read qualification remain closed.

The following App21/server44 evidence retains its original versions and scope.

[App21/server44 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json) passed normal packaged UI/SRP/native Iroh, 22 official entries, 30 registry results, 12 loaded local marks and five local keyless control cycles. Seven original images plus three supplementary image files (two unique views) frame Google Calendar and both Outlook cards. Exact owned process/staging/worker cleanup passed; provider calls and model turns were zero.

[Server/CLI44](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.44) has 12 verified assets, manifest `f61d94548d22525f06871f9f3884509e4ecbd2e6fdc109548a7fa48c9630df5c`, and its [exact installed qualification](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/calendar-mail-product-1.1.0b44-2026-10-17.json). Only two wheels were rebuilt; seven components were verified unchanged. The [fresh public installer44](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product44-public-installer-2026-10-17.json) separately passed combined server/CLI installation, dependency/version checks and the installed 22-plus-Custom catalog, without a source overlay or HOME/TMPDIR override. These checks made zero provider calls and started no server or model; native App acceptance remains separate. The following16/43/20 receipts retain their actual historical boundaries.

- [SDK 0.1.6 real reads and publication](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.6-2026-10-17.json): source `2ec7c114`, manifest `a1e87b9469cadfc1c8184e4ad704d0b7ed26ee7233f6145bf15baddfe19789f5`. The early CoinGecko output-ticker rejection and narrow correction are retained; six reads then passed.
- [Server 43 installed fixtures](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-installed-2026-10-17.json) and [normal public installation](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json): source `276704b2`, 12 verified assets, manifest `0458e049e3bfeafafff7c677670bdc30eeeb7a70ec8e93eac1742f6e45ba5e63`.
- [Product 43 workflow lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b43-2026-10-17.json): ordinary public install, CLI/SRP/device certification/Iroh/gateway; three read-only owner-authorized sources, six reads, real process restart and complete local disconnect/cleanup. No model or direct provider client.
- [App beta 20 native release](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-native-release-2026-10-17.json): source `276704b2`, all 10 original workflow jobs passed, six native manifests, 10 primary installers and 4 updater YAMLs, zero Actions artifacts.
- [App beta 20/server 43 GUI](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json): 19 official entries and 30 actual registry results in the same grid, nine local marks, five keyless local control cycles and seven reviewed images; no provider call/model/source overlay. Exact owned process and staging cleanup passed. Hosted `--no-sandbox` is not sandbox-security acceptance.

### Common enrollment and retained history

[ClickUp/GitHub/Notion public beta](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/oauth-public-beta-2026-10-17.json)
is an independent configuration rollout, creating no new provider grant.
Server 43 defaults to those three only when both operator settings are absent;
explicit `[]` or an empty environment value disables common enrollment. Fresh
keyless-only servers neither register with nor poll the broker. Released
server 40 needs the explicit allowlist. Host operators preserve their own
version pins, storage, grants, deployment receipts and release qualification.

Historical receipts remain immutable: [GitHub](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/github-oauth-2026-10-16.json),
[Notion](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/notion-oauth-2026-10-16.json),
[Slack](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/slack-oauth-2026-10-16.json),
[SDK 0.1.5 reads](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.5-2026-10-17.json),
[beta 41 workflows/initial EXDEV](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json),
[beta 42 distinct-filesystem installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json),
[App beta 19 native/recovery](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-native-release-2026-10-17.json),
[App beta 19/server 42 GUI](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
and [App beta 18/server 40 GUI](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app18-server40-marketplace-2026-10-16.json).
The source/publication manifest and qualification files in each release retain
the older component test matrices and signing/updater transition evidence.
Exa/Firecrawl provider evidence remains attributed to SDK 0.1.5/beta 41, not relabeled
as new beta 43 calls. No connector release qualifies the
[multi-source application composition contracts](./application-composition.md).

## Calendar and mail contracts: published since SDK 0.1.7

[SDK/runner 0.1.7](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.7)
is published from `f2cecfe3672e48a7724324fef5e41072cde697bf`, with **22 official
connectors plus Custom MCP** and 11 verified release assets. Manifest SHA256:
`65af35daccdf93278bd31a61ff00fbaf907ab62ed4afe89ff77d1f0d18890a56`.
The [exact SDK qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/calendar-mail-sdk-0.1.7-2026-10-17.json) records race/vet/vulnerability
checks, six-target/twelve-binary packaging, Python and Linux-native runner/broker
fixtures, and public installed-host acquisition. Other targets have cross-build
evidence; **no real Google/Microsoft consent, provider read or mutation is qualified**.

| SDK connector | Typed operations | Consent and execution boundary |
| --- | --- | --- |
| Google Calendar | 7: CalendarList list/get; events list/get/create/update/delete | Per-account connection; CalendarList read scope plus event scope; local write admission |
| Outlook Mail | 9: folders list/get; messages list/get; attachments list/get; drafts create/update; message send | `Mail.ReadWrite` does not grant `Mail.Send`; send requires its own scope and publish admission |
| Outlook Calendar | 7: calendars list/get; events list/get/create/update/delete | Per-account Graph binding; finite UTC writes with version preconditions |

[Server/CLI beta44 is public](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.44)
from `162bff9696c1dbcba0e64d3fc14ee7f59343d56d`, adopting SDK17 and its 22 official
entries. Its [installed Python qualification](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/calendar-mail-product-1.1.0b44-2026-10-17.json) passed, as did the [fresh public installer44](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product44-public-installer-2026-10-17.json) for server/CLI, dependency/version checks and the installed 22-plus-Custom catalog. The installer trial started no server or model and made zero provider calls. [App21 is public](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.21) with six native targets and 36 verified assets; [App21/server44 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json) passed.
The App21/server44 GUI has 22 official entries, 30 real registry results and five local keyless control cycles. App20/server43 retain their earlier 19-entry screenshots and receipts. Publishing a component never upgrades an installation
or enables a provider.

Common enrollment for `google_calendar`, `outlook_mail` and `outlook_calendar`
remains **off**. Google Calendar API enablement and both Calendar scope declarations
were completed on 18 October. The Microsoft shared app, developer terms and four
Web callbacks are also prepared. Its seven delegated permissions were saved on
19 October: `User.Read`, `offline_access`, `Mail.ReadWrite`, `Mail.Send`,
`Calendars.ReadWrite`, `Files.Read` and `Sites.Read.All`. This configures the app;
no admin or user consent has been granted. Client-secret custody, remaining
OAuth/client-authentication checks, publisher/tenant-policy requirements and
real consent/lifecycle qualification remain pending. An operator-owned app requires
its own valid registration and qualified receiving host. See
[setup and recovery](./connector-operations.md#calendar-and-mail-sdk-017)
and the [versioned SDK contract and limits](https://github.com/openagent-uno/openagent-tools/blob/main/docs/connector-calendar-mail-0.1.7-candidate.md).

## Provider registration checkpoint

- **Google:** The OpenAgent app/client, callbacks and test audience are prepared.
  Gmail, Drive, Analytics Data, Analytics Admin and Calendar APIs are enabled and
  verified. On 18 October the existing client saved
  `calendar.calendarlist.readonly` and `calendar.events`, alongside the previously
  declared connector scopes. The app remains in Testing; applicable verification,
  security assessment and real Calendar consent/lifecycle acceptance remain pending.
- **Microsoft:** Outlook Mail/Calendar and OneDrive/SharePoint adapters are published
  in SDK 0.1.8. On 18 October the shared Web app was registered for work/school and
  personal accounts, its four provider callbacks were saved and developer terms
  were accepted. On 19 October, the [registration checkpoint](https://github.com/openagent-uno/openagent-tools/blob/6b6364676a34a14339b97e5bd7a840d57b58d439/deploy/connector-auth/registrations/microsoft.json)
  verified seven saved delegated permissions: `User.Read`, `offline_access`,
  `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.Read` and
  `Sites.Read.All`. Neither admin nor user consent was granted. The production
  secret reference is still unset; client authentication, remaining OAuth settings,
  publisher/receiving-tenant requirements and real consent/lifecycle tests remain
  pending. Common enrollment stays off.
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

The current SDK18/server45 and App22/server45 Linux x64 visual boundaries are listed above; App21/server44 evidence remains historical.
The following detailed trials are historical; their exact versions, original
failures, provider gates and renderer-reload limitations remain unchanged.

The [App beta 19 native release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.19)
publishes 36 verified assets for six native targets from canonical source
`f01b946105857c92fcf14d8f7a83bcbf2fdad11a`. The
[native release receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-native-release-2026-10-17.json)
records five successful original native sets and the ARM macOS recovery,
which passed all five recovery jobs; the original failed run remains recorded.
Intel macOS ZIP and DMG launches passed. The separate
[Linux x64 App beta 19/server beta 42 marketplace receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
records qualifier source `8ddddd091cc12b066e6bc90be4e0f39b72e8f842`, ordinary
Join/SRP/device-certificate/native Iroh membership and unchanged public bytes.
It loaded 16 official entries and 30 registry results with six verified local
provider icons and no official tab, label or divider. Exa and Firecrawl each
passed Connect, disable/re-enable and disconnect with no credential form or
OAuth controls. Four actual screenshots were reviewed; owned process and
staging cleanup passed. Two corrected harness failures remain recorded.
No provider call, model, mock or source overlay was used. Hosted Electron ran
with `--no-sandbox`, so sandbox security and Mac/Windows marketplace GUI are
not qualified. Beta 41's four provider reads remain separate evidence.
The beta 18/server beta 40 trial below remains historical evidence.

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
3. Finish provider review/verification and remaining Google, Shopify and
   Postiz callback/consent flows; preserve the separately recorded limited
   ClickUp/GitHub/Notion trials and public beta. Complete real cancel, read,
   authorized write, renewal, restart and local disconnection in all products.
4. Activate the central Shopify webhook path only after the legacy compatibility
   delivery and each product's local privacy processing are tested, including
   duplicate notifications and offline recipients.
5. Test two real servers on one Shopify shop: simultaneous acquisition/refresh,
   offline peer, expired/lost envelope, recovery and fresh consent. Coordinate
   any remaining legacy app-token issuers during the transition.
6. Preserve the completed Linux x64 App beta 20/server 43 marketplace
   and five local keyless-control cycles. Qualify remaining native GUI platforms,
   sandbox security and native App provider operations independently. Keep SDK-only reads, beta 41 and beta 43 provider workflows, and each normal
   installer receipt attributed to their actual executions rather than
   extending GUI evidence.
   Build, sign and qualify supported product releases, preserve existing IDs,
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
