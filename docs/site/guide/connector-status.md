# Connector release and qualification status

Status updated on **19 October 2026**. Current published Python components are
**SDK/runner 0.1.10 and server/CLI beta48**, with **114 official connectors plus
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
| Shared Go module, runner and Python/MCP | SDK 0.1.10 public: 114 official connectors plus Custom MCP; canonical race/vet/vulnerability, cross-platform packaging and isolated Python/native qualification | Real-account acceptance for the 90 token profiles; untested Google/Microsoft operations and eligible-account SharePoint acceptance; native execution on every target |
| Server/CLI | Beta48 public from `a292a35c`, Core22/SDK 0.1.10/B6; 215 installed tests and 15 React source groups passed; two new wheels and seven exact beta47 reuses | Normal public-source installer48 passed; live website byte equality tracked separately in the installer receipt; Windows/macOS server execution and independent host rollout |
| Normal keyless workflows | Three connections and six reads across a real restart, followed by disconnect/tombstone/source removal and cleanup | Only Parallel fetch, Context7 query and CoinGecko global; workflow metrics do not expose provider HTTP attempt telemetry |
| Standalone App | Beta22 public, 36 verified assets/six native targets; signed/notarized macOS and Intel ZIP/DMG launches; actual App22/server45 Linux x64 marketplace, blank Postman setup and one local Exa cycle passed | Mac/Windows marketplace GUI, hosted sandbox security and native App provider operations |
| Core / Tools / Host Tools | Independently pinned public Core beta 22, Tools beta 4 and B6; unchanged component contracts and manifests | Component publication does not update an installed host or attest privacy coverage |
| Common authentication service | Broker `c256a3d4`, image `279833ea`: fourteen configured profiles, Shopify restricted to two approved QA hosts; one Ready writer, health/readiness 200 and unsigned request 401 | Google data-access review/approval and required assessment; eligible-account SharePoint consent/site access; untested provider operations and loaded capacity |

### Current Python release and the visually qualified pair

[Server/CLI48](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.48)
is public from `a292a35c422a56ea33c3809f3c3938b988ba05c6`, adopting
[SDK/runner 0.1.10](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.10)
from `db0f76941b8b9dd25b36502c765c84630e459dd2`. The catalog remains
114 official entries plus Custom MCP, with 315 reads and 82 actions. The
[SDK qualification receipt](https://github.com/openagent-uno/openagent-tools/blob/fd16352/docs/connector-sdk-0.1.10-qualification.json)
records canonical race/vet/vulnerability, six bundles and the wheel, Linux-native
execution and eleven public asset verifications. Other targets were cross-built.
All twelve product asset sizes/digests matched API and anonymous downloads.
Product manifest SHA256: `14fe6a8d2e8fa32ad0e9aafdeb198efa44f32da455bd1a27fda264ec93d16948`;
SDK manifest: `44226a90ff5a0226a5fadfa924db8da1d37bec85491cae8d6671843a2630ea6b`.
The [beta48 qualification asset](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.48/qualification.json)
records 215 installed tests and fifteen separate React source groups, two new
server/CLI wheels and seven byte-identical beta47 dependency wheels.
SDK 0.1.10 adds bounded Postiz error diagnostics, not new provider acceptance.

The public installer source at `85ab841b` pins beta48/SDK 0.1.10; its 8,723 bytes
hash to `4678c5b37cf2201e770ae8feaab5b18bbff2bf5bcd221e46a7ec6c8425894285`.
The [normal public-source installer48](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product48-public-installer-2026-10-19.json) passed at 13:24:41 UTC: separate server/thin CLI installation, two dependency checks, ORM, the 114-plus-Custom catalog and seven-provider default, with no HOME/TMPDIR override, source overlay or provider call. This qualifies the immutable public source; live website byte equality is recorded separately in the installer receipt. The dated [normal live installer47](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product47-public-installer-2026-10-19.json)
remains evidence for beta47 only, not a beta48 install or provider trial.

Beta48 qualifies the installed host's opt-in Shopify admission controls for a
fresh canonical text-history cohort: configuration alone cannot attest privacy
coverage. The deployed Shopify-only broker QA gate binds two approved host
identities and the QA store while preserving the other thirteen providers.
Both normal beta48 hosts reported Shopify available through certified SRP.
Only host A started a pending consent transaction; host B had not started one.
No grant or provider read has completed: user consent, privacy notifications
and two-host acceptance remain pending; Shopify is not a default. Jira now has a verified Free QA site/project.
The signup flow automatically assigned a Standard trial, immediately downgraded
to Free without card/payment entry. The existing private app's regenerated
secret remained masked: the current browser control could not retrieve the
credential copied through the official UI (even copying the public client ID
returned no clipboard text). No value was custodied; Jira has zero actual OAuth/API
qualification and remains disabled. Sharing beyond the app owner is separate.

Beta48 retains beta47's absent-setting default: **ClickUp, GitHub, Notion, Outlook Mail,
Outlook Calendar, OneDrive and Slack**. Google remains explicit limited-trial
opt-in; the full eleven-ID replacement example is in
[operations](./connector-operations.md#standalone-configuration). SharePoint is
separate, and broker availability for Postiz does not make it a default.
App22 is unchanged: its GUI and the seven Google/Microsoft lifecycles retain
server45/SDK18 attribution, with no App22/server47 or server48 GUI claim.

The [Slack/Postiz configuration checkpoint](https://github.com/openagent-uno/openagent-tools/blob/4b1489e6ff8c0709f42e3fb4ac97584c42cd623f/deploy/connector-auth/qualification-2026-10-19-slack-postiz-activation.json)
records the later thirteen-profile broker, preserving the same image and earlier
rows. Public health/readiness returned 200 and unsigned requests 401. This
configuration-only rollout added no grant or provider call; Postiz real-account
acceptance remains unqualified and Atlassian is not enabled. The first beta47
Postiz OAuth poll returned HTTP503 and was cancelled normally without retry.
The [broker-only compatibility correction](https://github.com/openagent-uno/openagent-tools/blob/b55cbebe8cf6838a445cf77cd4f2598b7152474f/deploy/connector-auth/qualification-2026-10-19-postiz-compatibility.json)
then passed its tests, scan and image-only rollout at 12:13:26 UTC, retaining
all thirteen profiles. That checkpoint used source `60665d2f90fb2ae3cee6a0f159ca12999af54819`,
image `a303d481e9fd5462f77220c7e911247cb53f07e8764b27acd19522e08987aad4`.
It retained thirteen profiles; the later scoped Shopify deployment is recorded above. In the [subsequent normal beta47 trial](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/postiz-product-1.1.0b47-2026-10-19.json),
a fresh OAuth connection succeeded, but the one advertised `social.postiz.integrations.list`
workflow returned `failed`. The normal run-read HTTP200 did not turn that into
a successful provider read; provider HTTP status and a fixed failure code were
not captured. There was no workflow resubmission, write, forced refresh or
restart/post-read; underlying provider attempt counts were not observed.
Normal disconnect, source removal, process/profile cleanup and owned-worker
deletion passed. Postiz remains non-default with API acceptance unqualified.
The subsequent actual cloud-account UI showed Choose Plan: its advertised
seven-day trial required a card and a USD2 authorization hold. No card, trial,
subscription or payment was activated. The pinned primary source applies [authentication middleware](https://github.com/gitroomhq/postiz-app/blob/e7ceab7b661bb69d7479313b81935028c514d741/apps/backend/src/services/auth/public.auth.middleware.ts#L37-L65)
to the [public integrations controller](https://github.com/gitroomhq/postiz-app/blob/e7ceab7b661bb69d7479313b81935028c514d741/apps/backend/src/public-api/public.api.module.ts#L34-L37).
With Stripe billing configured, that guard rejects an organization without a
subscription. This establishes a concrete cloud-plan prerequisite, not the
HTTP status received by the earlier failed workflow. No new provider probe was made.

### Additional real beta47 acceptance on 19 October

[Outlook Calendar separately passed the normal server47/SDK19 owner-calendar
flow](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/outlook-calendar-product-1.1.0b47-2026-10-19.json): `canShare` and `canEdit` were checked from real list/get results before
creating an event with no attendees, reading it, updating with its version
precondition, rereading and deleting it. Explicit refresh, a real same-profile
process restart, post-restart read and ordinary disconnect/tombstone/source
removal passed at 11:00:51 UTC. This adds no primary/private-calendar guarantee
and does not qualify mail sending or every calendar/account.

The separate [Google4 beta47 demonstration and lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/google-demo-product-1.1.0b47-2026-10-19.json)
passed generated-file creation, metadata and
content reads, content update and revision verification. SDK19 does not expose
metadata trash as a catalog tool: the cleanup helper stopped before submitting
that workflow. The authorized owner moved the exact QA file to trash in the
Google UI; two normal API reads independently verified the trash state and
owned marker at 11:11:51 UTC. This is UI-assisted cleanup, not connector trash
acceptance. The new Gmail trial created one generated self-addressed draft and submitted
that same draft once through a normal workflow at 11:22:52 UTC. The exact sent-message read verified the same sender/recipient, generated
subject marker, SENT and no DRAFT; a query using the pre-send canonical draft
identity found no remaining draft. There was no second send, existing-mail
change or other recipient. Google Calendar also passed a newly generated private, no-attendee event
create/get/ETag-update/get/delete cycle on the owner-verified calendar; no
independent post-delete absence read is claimed. Analytics passed the normal
account-summary read, with no report or write. All four beta47 Google connections then passed explicit refresh, a real
same-profile restart, four post-restart reads and normal disconnect at
11:38:42 UTC. This is a separate trial from the historical server45 lifecycle.
Owned QA processes were stopped and the exact temporary profile, including
credentials, was erased at 11:50:35–36 UTC after the safe evidence export was
verified. The 272-second actual demonstration video is now encoded and visually
reviewed, then uploaded unlisted. Its reviewer URL was supplied privately in
Google’s console, where the three
justifications were saved in Google's actual form. At 12:11:38 UTC the
Verification Center confirmed **data access in review**. Submission is complete;
Google approval and required CASA completion are not established.

The following beta46 evidence retains its actual version and counts.

[Server/CLI46](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.46)
is public from `6b0d62e42abca87c0e0e07b5ae3f28848734840b`, with 12 assets whose
API and anonymous download digests/sizes matched. Manifest:
`f0c85580a230a6ae3a748a7ed12a6d54d442dca383925666f615a937b698c444`.
The [public qualification asset](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.46/qualification.json)
records 215 installed tests and 15 React component scenarios. Two server/CLI
wheels changed; seven dependency wheels were reused byte for byte from beta45.
Core22, SDK18 and Host Tools B6 remain pinned. The [installed qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product46-installed-2026-10-19.json)
retains that release's test scope. The [normal public-source installer46](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product46-public-installer-2026-10-19.json)
passed separate server/CLI installation, two dependency checks, ORM, the
114-plus-Custom catalog and the six-provider constructor default, without
provider calls or enrollment. It used the immutable public script at `4e6a8bbb`
(SHA256 `05fcb4f1f5c984253efd4e6b01288fb4827575bf213a05d8b43a3d3455f3fe0b`).
The linked installer receipt tracks live website byte equality separately from
the installation tests against the immutable public source script.

Beta46's historical absent-setting default was **ClickUp, GitHub, Notion,
Outlook Mail, Outlook Calendar and OneDrive**. Beta47 adds Slack; Google and
SharePoint remain explicit opt-ins. Explicit `[]` still disables common enrollment. App22 is unchanged; its actual native marketplace
screenshots and the following provider trials remain attributed to server45.
No App22/server46 GUI or newly repeated provider trial is claimed.

The following beta45 receipts retain their original versions and test counts.

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
profiles are technically configured; the bounded Mail/Calendar/OneDrive
lifecycles are recorded below. File-content reads and eligible-account
SharePoint acceptance remain unqualified.

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
Servers43–45 defaulted to those three only when both operator settings were
absent. Beta46 adds the three bounded-qualified Microsoft profiles to that
default; beta47 then adds Slack following its broker activation. Explicit `[]`
or an empty environment value disables common enrollment. Fresh
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
evidence. Those SDK17 source/packaging checks alone do not qualify real consent,
provider reads or mutations; the dated product trials record separate acceptance.

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

The SDK18 broker image passed its [19 October image-only checkpoint](https://github.com/openagent-uno/openagent-tools/blob/7e3c6f829b22a8dcfa3bdce79416580a365ab12f/deploy/connector-auth/qualification-2026-10-19.md).
That update retained the existing three-provider configuration and made zero
provider calls or new grants. The later startup-fixed broker and additive trial
configuration passed technical readiness on 19 October at **08:14:17 UTC**:
eleven configured providers, one Ready writer without restart, health/readiness
200 and unsigned protected requests rejected with 401. The three existing beta
providers are preserved alongside four Google and four Microsoft profiles.
The [diagnostic image checkpoint](https://github.com/openagent-uno/openagent-tools/blob/4c73501009c7f9d81dd0adec2223232dee839fcc/deploy/connector-auth/qualification-2026-10-19-diagnostics.json)
then passed at **08:43:13 UTC**, preserving the same eleven-provider configuration.
The current broker is source `645e0484`, image
`sha256:04d942f6cc69a59af958911a21a3f4ca2e1901a456d43220b8ac3061a6e13c5d`.
At that server45 checkpoint, the receiving-server default was
ClickUp/GitHub/Notion. The beta46/47 defaults are recorded above; explicit
host configuration and each account's actual consent remain separate. Technical readiness is not an OAuth
or provider API acceptance result.

The first additive configuration attempt failed the broker's startup check:
a Shopify-only test tenant was passed to every provider. The prior three-provider
configuration was restored and health/readiness returned 200. The
[narrow startup fix](https://github.com/openagent-uno/openagent-tools/commit/975d9426b1373b1db0c1b7f75d329451f3cf5d75)
now supplies that tenant only for Shopify; its source regression covers the five
new provider profiles, existing registrations and invalid tenant/configuration
rejection. Remote auth/OAuth tests, vet and the static Linux amd64 broker build
passed. The full image scan and corrected eleven-provider rollout passed with
image `sha256:1040f2873a8bdb35f128cb0cee6851e718b787a2328619173e1c8466bd20121a`.
This broker-only fix does not change the published SDK18 release or establish
OAuth acceptance; the original failed attempt and rollback remain recorded.

Google Calendar API enablement and both Calendar scope declarations were saved
on 18 October. The following four-connector lifecycle ran while the Google app
was in Testing with one approved test user. Later on 19 October the existing
external app was published In production, its HTTPS homepage URL-prefix was
verified via Google's HTML file, and Branding was verified and published.
Data-access verification remains incomplete. The real unlisted YouTube demo
URL and three justifications were saved, then the Verification Center confirmed
**data access in review**. Approval and the required assessment remain incomplete. The observed unverified user cap is 100. Google remains an explicit
host opt-in; published branding does not add it to receiving-server defaults.
See the [verification dossier](https://github.com/openagent-uno/openagent/blob/main/docs/verification/google-production-verification-2026-10-19.md).
The original Microsoft shared registration initially verified four Web callbacks,
work/school plus personal-account audience and seven delegated permissions: `User.Read`, `offline_access`,
`Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.Read` and
`Sites.Read.All`. A new immutable client secret entered protected production
custody on 19 October at 07:24 UTC. Its read-only projected mount was then
verified by normal broker startup as UID 65532. The app secret is now stored,
mounted and technically configured; a successful token exchange, user/admin
consent and provider API acceptance are separate. A fresh receiving session has
connected **Google Drive, Analytics, Calendar and Gmail**, with normal reads and
owner refresh passed for each. The [four-connector lifecycle receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/google-four-product45-oauth-2026-10-19.json)
then passed a real same-identity server restart, four post-restart workflow reads
and normal disconnect/tombstone/source removal for each connection. This is eight
actual workflow reads across the restart; provider HTTP-attempt telemetry is not
exposed. The later [Microsoft and final-cleanup receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/microsoft-three-product45-oauth-2026-10-19.json)
closes the shared receiver: owned processes stopped and both exact QA workers
were deleted and confirmed absent. The earlier receiving session passed Google
Calendar/Gmail/Outlook Calendar reads and owner refresh, plus a five-workflow
private Google Calendar event create/get/ETag-update/get/delete trial. Its finite
deadline then removed local state; **restart and disconnect did not pass for
that earlier cohort**. No provider-wide revocation is claimed from that loss.

Outlook Mail's subsequent ordinary product poll returned HTTP503. The closed
broker diagnostic identifies **`stage=scopes`, `reason=scope_config`,
`provider_error=none`**. Returned scopes exceeded that provider configuration;
no raw scope names, token or provider body were read or exported by the operator. Microsoft
[documents cumulative consent for the same app and resource](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/resources-and-scopes#consent-lifetime).
The permission boundary remains fail-closed; filtering metadata would not narrow
the raw token delivered to a recipient. Separating the Microsoft registrations
by connector family preserves one shared app per family across receiving
products. Three new family registrations for Mail, OneDrive and SharePoint now
have verified Web callbacks, delegated permission declarations and separately
custodied immutable client secrets. Their static delegated permission counts
are four, three and three respectively; implicit tokens and public-client flows
are disabled. The original Calendar registration and secret are preserved; its
callback and static permissions are restricted to Calendar, `User.Read` and
`offline_access`. Its prior account grant was separately removed by the operator,
not by losing the old QA profile. The [family configuration rollout](https://github.com/openagent-uno/openagent-tools/blob/a52c1bbdd45fca768052cfd37b89f0ecba238f58/deploy/connector-auth/qualification-2026-10-19-microsoft-families.json)
passed at **09:19:35 UTC** with the same image, one Ready writer and eleven
configured providers. New Mail, Calendar and OneDrive connections then passed
normal redemption, one workflow read each and explicit owner refresh. A real same-identity process restart then passed, followed by three post-restart
reads and three local disconnects with disabled tombstones and source removal.
The three issuing app identities also matched the public product metadata.
The [three-connector lifecycle and final-cleanup receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/microsoft-three-product45-oauth-2026-10-19.json)
records six authorized workflow reads across the restart and complete owned
runtime/worker cleanup. Provider HTTP-attempt counts are not exposed; local
disconnect does not claim provider-wide revocation.
Mail covered folders only; no message body, draft or send is qualified. OneDrive
covered `drives.list` without provisioning or file changes. Outlook event writes
were not exercised because the approved calendar owner could not be verified
by the current QA flow; no event was created.

SharePoint was blocked by the provider **before consent**: the personal account
was refused with a requirement to use a work or school account. No callback,
site read, organization admin consent, new account/tenant or paid license is
claimed. An eligible work/school-account trial remains pending; no license
requirement is inferred from this observed account-type message.
An operator-owned app requires
its own valid registration and qualified receiving host. See
[setup and recovery](./connector-operations.md#calendar-and-mail-sdk-017)
and the [versioned SDK contract and limits](https://github.com/openagent-uno/openagent-tools/blob/main/docs/connector-calendar-mail-0.1.7-candidate.md).

## Historical server45 real-account trial scope — 19 October

These normal public server45/SDK18 trials are independent of the native App22
marketplace screenshots. All seven successful rows include consent redemption,
owner refresh, a real same-identity server restart, a repeated workflow read and
local disconnect/tombstone/source removal. Final owned runtime/worker cleanup
passed. They do not qualify every operation or every account type.

| Connector | Actual API scope | Result and remaining boundary |
| --- | --- | --- |
| Google Drive | `files.drive.search` | Read lifecycle passed; no file mutation |
| Google Analytics | `account_summaries.list` | Read lifecycle passed; reports/other operations untested |
| Google Calendar | `calendars.list`; separate earlier private-event create/get/ETag-update/get/delete | Read lifecycle and separate event cleanup passed; no attendees or invitations |
| Gmail | `messages.list` | Read lifecycle passed; no message body, draft or send acceptance |
| Outlook Mail | `folders.list` | Separate-family read lifecycle passed; no message body, draft or send acceptance |
| Outlook Calendar | `calendars.list` | Read lifecycle passed; event write not tested because the authorized owner was not independently verified |
| OneDrive | `drives.list` | Read lifecycle passed; no provisioning, file-content read or modification |
| SharePoint | No consent callback or site-data call | Personal account rejected before consent; eligible work/school-account trial remains pending |

## Provider registration checkpoint

- **Google:** Existing OpenAgent client, callbacks, production secret reference
  and required APIs are preserved. Calendar scope declarations were saved on
  18 October. The historical four-profile trial used the Testing audience.
  Later on 19 October the external app was published In production; Search
  Console verified the HTTPS homepage URL-prefix using the vendor HTML file,
  and Google verified/published its Branding. No DNS TXT/Domain-property
  verification is claimed. Data-access verification is still unverified, with
  an observed 100-user cap. Three scope justifications/categories are entered,
  and the unlisted reviewer URL was saved privately in Google’s console. The Verification
  Center subsequently confirmed **data access in review** at 12:11:38 UTC. Applicable security-assessment completion is not
  recorded. These steps do not change scopes or enable Google by default.
  Fresh Gmail, Drive, Analytics and Calendar connection/read/refresh passed;
  the earlier private Calendar-event mutation/cleanup trial also passed. The
  fresh session's real restart, four post-reads and per-connection disconnect/
  tombstone/source removal passed. Final shared receiving-runtime and worker
  cleanup also passed. That bounded server45/SDK18 evidence is separate from
  scope verification, any assessment and untested operations.
- **Microsoft:** Outlook Mail/Calendar and OneDrive/SharePoint are published in
  SDK18. The original shared registration verified four Web callbacks, global-cloud
  work/school plus personal audience, implicit tokens disabled and public-client
  flows disabled; seven delegated permissions were initially saved. Its immutable
  client secret entered protected custody and normal read-only startup passed.
  Following the Mail refusal, the prepared registration layout separates connector
  families and restricts the original registration to Calendar. Outlook Calendar connected/read/refreshed;
  Outlook Mail's OAuth poll was rejected at the configured-scope boundary by
  the diagnostic broker. The raw scope names were not collected. Separate Mail,
  OneDrive and SharePoint registrations, verified callbacks/permission declarations
  and immutable secret custody are complete; the original Calendar registration
  is retained. The family configuration rollout passed; Mail, Calendar and
  OneDrive redemption/read/owner-refresh, real restart, post-reads and local
  disconnect/tombstone/source removal passed. Final owned runtime/worker
  cleanup passed. SharePoint's personal-account attempt stopped before consent and
  requires an eligible work/school-account trial; no license inference is made. Publisher or tenant restrictions are evaluated when
  encountered; they are not asserted as a universal consent prerequisite.
  The [SharePoint credential rotation](https://github.com/openagent-uno/openagent-tools/blob/2e685b6a68b1fede45b61ed5530cc993ad4a80be/deploy/connector-auth/qualification-2026-10-19-microsoft-sharepoint-rotation.json)
  removed the prior provider credential, and the replacement projection passed eleven-provider
  health/readiness. App identity, scopes, image and persistent metadata were
  preserved; this does not qualify SharePoint consent or site access.
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
- **Postiz:** the existing OpenAgent registration and common callback are
  retained. The replacement credential was custodied and broker configuration
  activated on 19 October. After the initial HTTP503 and the qualified broker
  correction, a fresh normal beta47 OAuth connection succeeded. Its one
  integrations-list workflow failed without a captured provider status or fixed
  error classification. The connection was normally disconnected and owned
  cleanup passed. No read, restart or refresh acceptance is inferred, and Postiz
  is not a receiving-server default.
- **Token/account connectors:** no common OAuth app is needed. Product-local
  configuration is implemented; dummy-token tests do not validate a real account.

## What the tests establish

The historical SDK18/server45 and App22/server45 Linux x64 visual boundaries are listed above; App21/server44 evidence remains historical.
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
3. Preserve the dated Google and Microsoft Mail/Calendar/OneDrive
   lifecycles recorded above, including the historical Google Testing boundary. Google data-access verification, the required
   data-access review/approval and the required security assessment,
   eligible-account SharePoint acceptance and untested operations remain pending,
   alongside Shopify privacy/multi-server acceptance for the already approved
   existing app and Postiz API acceptance. No additional provider
   app review is inferred for either.
   Each product must qualify its own cancel, read, authorized write, renewal,
   restart and local disconnection; these trials do not attest every operation.
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
