# ChatGPT app coverage and expansion

Recorded **16 October 2026**. OpenAgent is expanding its shared connector library across the publicly visible ChatGPT app directory. The observation includes **16 category pages, 4,219 card occurrences and 4,133 distinct display names**. Names are not unique provider identities: different app IDs can share a name, and the visible directory varies by date, region and account.

The directory does not publish adoption counts. The first 50 positions below preserve its editorial **Popular** order; they are not measured usage rankings. Services outside Popular remain in the full inventory. Publication in ChatGPT does not establish an API/MCP available to independent clients, transferable OAuth credentials, commercial eligibility or feature parity.

The complete [readable inventory](https://github.com/openagent-uno/openagent-tools/blob/main/docs/chatgpt-app-coverage.md) and [machine-readable snapshot](https://github.com/openagent-uno/openagent-tools/blob/main/docs/chatgpt-app-coverage.json) preserve all observed category occurrences and provider research. Unresearched entries are explicitly unknown, rather than claimed unavailable APIs.

The latest shared component is [SDK18](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.8),
with **114 official connectors plus Custom MCP**. [Server/CLI45](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.45)
adopts it. Ninety new token profiles each expose two specific reads; read-only
OneDrive/SharePoint add explicit authorized resource selection. These are
qualified implementation/protocol fixtures, not 90 new real-account trials or
full ChatGPT app parity. Provider token permissions and Google/Microsoft OAuth
activation retain independent gates. [App21](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.21)
remains public; App22 publication and actual 114-entry GUI qualification are
pending. The App21/server44/SDK17 visual receipt below remains versioned.

## Visually qualified standalone pair and retained provider evidence

The current [App21/server44 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json) passed 22 official entries and 30 actual registry results in one grid, 12 local mark checks and five keyless local control cycles. Seven original screenshots plus three supplementary files (two unique views) show the Calendar/Outlook cards. Normal SRP/Iroh and owned cleanup passed; zero provider calls or models. The SDK16/server43/App20 evidence below remains historical.

[SDK/runner 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.6)
is public from source `2ec7c114a49b72460addc00fc8e8d6547a683b59`, with 19 official
adapters plus Custom MCP. [Server/CLI beta 43](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.43)
adopts it with Core beta 22 and Host Tools 1.0.0b6. [App beta 20](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.20)
is independently published for six native targets.

| Keyless connector | Typed read tools | Actual qualification |
| --- | --- | --- |
| [Exa](https://exa.ai/docs/get-started/exa-mcp) | `files.exa.search`, `files.exa.fetch` | SDK 0.1.5 reads; beta 41 fetch workflow lifecycle |
| [Firecrawl](https://docs.firecrawl.dev/mcp-server/keyless) | `files.firecrawl.search`, `files.firecrawl.scrape` | SDK 0.1.5 reads; beta 41 scrape workflow lifecycle |
| [Parallel Search](https://docs.parallel.ai/integrations/mcp/search-mcp) | `files.parallel.search`, `files.parallel.fetch` | Both SDK 0.1.6 reads; beta 43 fetch before/after restart |
| [Context7](https://github.com/upstash/context7) | `files.context7.resolve_library`, `files.context7.query_docs` | Both SDK 0.1.6 reads using an actually resolved library ID; beta 43 query before/after restart |
| [CoinGecko](https://docs.coingecko.com/docs/mcp-server) | `files.coingecko.price`, `files.coingecko.global` | Both SDK 0.1.6 reads; beta 43 global before/after restart |

The [SDK 0.1.6 receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.6-2026-10-17.json)
records remote source/package qualification and six real bounded reads, each
HTTP200/one attempt. An initial global-ticker output rejection remains recorded;
a narrow output-only compatibility fix passed the complete six-read rerun.
The [normal public installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json)
and [three-connection/six-workflow lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b43-2026-10-17.json)
passed separately. Workflows crossed normal certified CLI/Iroh/gateway APIs,
preserved connection IDs across a real restart, then disconnected with local
source removal and cleanup. Workflow-result byte metrics do not imply observed
provider HTTP/attempt telemetry.

[App beta 20/server 43 Linux x64 GUI](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json)
passed 19 official entries with 30 real registry results in one grid, nine marks,
five local keyless control cycles and seven reviewed screenshots. The GUI made
zero provider calls or model turns. Hosted `--no-sandbox` does not establish
sandbox security or Mac/Windows marketplace GUI acceptance.

Keyless mode needs no account, API key or OAuth grant; anonymous quotas and local
owner/tenant permissions still apply. There is no paid fallback, token refresh
or automatic broker enrollment. [SDK 0.1.5](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.5-2026-10-17.json),
[beta 41](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json)
and [App beta 19/server 42](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
retain their exact historical scope. Exa's earlier search returned output
without the expected OpenAgent reference; API success is not result relevance.
See [setup and configuration precedence](./connector-operations.md).

## First implementation batch: GitHub and Notion

**SDK/runner 0.1.4 is published.** The [qualified shared prerelease](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.4) contains the GitHub, Notion, Slack and Jira adapters. Server/CLI beta 40 adopts this library; other installed products retain their own version pins until updated. The two provider registrations were created under OpenAgent; app secrets are held in encrypted production storage. Common enrollment opened for ClickUp, GitHub and Notion on 17 October as a
limited public beta. Server beta 40 requires an explicit provider allowlist;
each connection still requires local authorization and provider consent.
GitHub and Notion completed the limited authorized standalone QA lifecycles described below. Registration and source fixtures alone do not prove real access.

| Provider | Candidate tools | Boundaries |
| --- | --- | --- |
| GitHub | 17 typed operations: repository discovery, branches/commits/trees/base64 blobs, issues/comments and pull-request inspection | GitHub App with selected repositories; content and pull requests read-only, issues writable when the receiving product permits it. Explicit page/per_page; 4 MiB JSON response cap, including base64. Truncated trees remain marked truncated. |
| Notion | 8 typed operations: title search, pages, blocks and user profiles; create/update pages and append text blocks | Public OAuth connection with explicit page selection; search is not full-text. Writes support title/rich_text properties and flat text blocks, with no templates, uploads, external URLs or mentions. Profiles exclude email addresses in the registered app. |

API requests originate from the receiving server using its local credentials. Normal provider traffic is not routed through the authentication broker. The receiving host controls identity, authorization, write permission, encrypted storage and audit. Both adapters pin the API origin and version; mutating operations have no automatic retry. Provider capabilities and local tool permission remain separate checks.

For product setup, use [Using connectors](./connectors.md). These candidate providers become usable through the same App marketplace, authenticated server API and CLI only after a qualified SDK/runner release is adopted and an approved OAuth registration is configured. They are not silently activated in an older installation.

## Notion real-provider QA

On 16 October, a private standalone candidate completed Notion OAuth with
explicit selection of one new empty private QA page. It read that page, changed
and independently verified its title, restored the exact original title and
local write policy, refreshed access, read the page after a real server process
restart, and disconnected the local connection. Existing pages were not selected.

The normally installed private product wheels used public Core/Storage beta 22
and SDK 0.1.3 with its supported runner-path override to the private candidate
runner. Calls crossed the ordinary certified gateway and authorized workflow
execution, without a model or direct test-client provider calls. The run-detail
path handled temporary readiness with typed `503 warming` responses; no history
fallback or automatic provider-write retry was used. The
[qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/notion-oauth-2026-10-16.json)
records stages and evidence hashes. This qualifies only that page lifecycle;
remaining tools and native App provider acceptance remain separate. Common
Notion enrollment opened in the independent three-provider beta on 17 October;
that configuration rollout adds no new provider lifecycle qualification.

## GitHub real-provider QA

On 16 October, a private standalone source candidate completed GitHub OAuth,
repository reading, creation/reading/closure of a disposable issue, explicit
owner refresh, a read after server restart, and local disconnection. The app was
installed only on an explicitly approved private QA repository with Actions
disabled. API calls ran on the receiving server; no language model was used.
The temporary server was removed after disconnecting.

The [lifecycle receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/github-oauth-2026-10-16.json)
records exact source and dependency pins. Native App provider acceptance, remaining
tools and receiving-product rollout remain separate. The run also exposed
a temporary history-readiness error in the product. A targeted regression now
verifies the source correction: 503 while preparing, then an authorized result,
with another verified user denied. The product fix ships in server/CLI beta 40 with SDK/runner 0.1.4. Existing installations keep their prior pins until updated.

## Next candidate batch: Slack and Jira

The published 0.1.4 library contains **9 Slack Web API tools** and **9 Jira REST API tools**. Linux worker contract tests, vet and both runner/broker builds passed. Those source checks qualify fixture behavior separately from the limited real Slack lifecycle below; Jira consent and receiving-product acceptance remain pending. Server/CLI beta 40 adopts the published library; other receiving products qualify their own rollout.

| Provider | Candidate tools | Boundaries |
| --- | --- | --- |
| Slack | Token identity, conversations/list/info/history/replies, user information, text post/update/delete | Confidential OAuth user tokens, no bot-token fallback or impersonation. Preserves catalog ID `slack-import`. The workspace comes from Slack and cannot be changed during renewal. History and replies return at most 15 messages per page; no automatic retry. Unlisted commercial-app rate limits apply. |
| Atlassian / Jira | Accessible sites, projects/list/get, enhanced JQL search, issues/get/create/update and comments/list/create | Resource-level OAuth app, classic read/write Jira scopes and rotating refresh. The server lists granted sites and verifies the selected `cloud_id` against the provider before saving it. Tools cannot provide another site or API URL. Supports a bounded field/text subset; no Confluence, admin operations or Rovo parity claim. |

The Atlassian app and callback are registered, with secret custody still pending. Slack's OpenAgent app, callback, ten user scopes and token rotation are saved, with its secret in encrypted production storage; one authorized receiving installation completed the limited lifecycle below. Slack public distribution remains disabled. Jira secret custody and real
consent remain pending; neither is enabled for common enrollment. [Primary Slack rate-limit reference](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) and [Atlassian OAuth reference](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) describe the provider constraints.

### Slack real-provider QA

On 16 October, the private standalone candidate completed Slack consent, scoped
workspace/channel reads, an approved message create/read/delete with verified
cleanup and restoration of the local write policy, owner refresh, a read after
a real server restart, and local disconnection with the connection disabled.
The owned runtime was then stopped. Qualifying provider operations used the
normal certified CLI, gateway and authorized workflow without a model. A
separate read-only `auth.test` response-header diagnostic ran on the receiving
QA server with approved existing access; it exported no token values, made no
database writes and is excluded from normal-path acceptance. The normally
installed private product used public Core/Storage beta
22 and SDK 0.1.3 with the supported private runner-path override.

The first refresh returned 503. After the reviewed broker compatibility fix and
explicit reconsent, owner refresh passed at 18:32:01 UTC, the post-restart read
passed at 18:32:52 UTC, and disconnect passed at 18:33:00 UTC. The approved
17:57 message lifecycle remained valid for the same app, scopes and receiving
installation; it was not automatically retried during recovery. An initial
certified-client connection also disconnected before startup readiness; the
later attempt passed after 43 seconds. These failures and their recovery are
retained in the [lifecycle receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/slack-oauth-2026-10-16.json).
The shared 0.1.4 artifacts and their server/CLI consumers are now published.
Remaining tools, native App provider acceptance, independent-host rollout and
general enrollment remain separate. This does not qualify Slack's separate
MCP service or provider-wide app revocation.

### Candidate setup and renewal

After a qualified runner and receiving-product release, connect these providers from the same marketplace cards. For Jira, complete OAuth and choose a site from the server-returned list. App beta 18 offers **Choose Jira site**; the authenticated CLI offers `connectors sites <connection-id>` and `connectors select-site <connection-id> <cloud-id>`. The server rechecks the current provider grant on every site change and invalidates old tool references.

App beta 18 also provides **Refresh access**, backed by `POST /api/connectors/{id}/refresh` and `connectors refresh <connection-id>`. This owner-authorized operation is useful when a provider supplies a refresh token without an expiry, as documented for Notion. It does not invent a token lifetime or replace consent. Connections without a refresh credential require reconnection. The server serializes renewal, rechecks consent/permissions after I/O and atomically saves the latest pair. These actions ship in server/CLI beta 40. App beta 18 publishes their graphical controls. The Linux x64 marketplace presentation is qualified separately; packaging these controls does not establish Jira consent or native App provider operations. The earlier App beta 17 does not expose them.

## Six further Popular interfaces: research only

The [17 October primary-source audit](https://github.com/openagent-uno/openagent-tools/blob/main/docs/chatgpt-primary-interface-audit-2026-10-17.json)
adds Remote Desktop Commander (1), Flaim Fantasy (3), WPVibe (5), Windsor.ai
(11), Upwork (14) and Granola (19), bringing the inventory to **32 researched
display-name groups**. All six remain unimplemented and unqualified official
integrations. The directory table below links those interfaces; the observed directory
counts remain unchanged.

Granola, Windsor and Upwork document independent-client MCP OAuth with dynamic
client registration, so that route does not require assuming a new manually
registered OpenAgent app. Account consent and actual client compatibility
remain gates; Upwork's separate GraphQL API has its own key/application path.
Remote Desktop Commander also needs an authorized paired device, Flaim an
authorized league and WPVibe WordPress authorization. Their exact registration
details and the documented source-access limitations remain explicit in the
receipt. None is a documented new public-read keyless subset. No provider
registration, grant, MCP/API call or SDK implementation was performed by that
audit. The current App beta 20 GUI acceptance does not implement those six interfaces.

### Parallel Search: published adapter and separate metadata history

The [preparation record](https://github.com/openagent-uno/openagent-tools/blob/main/docs/parallel-search-preparation.md)
preserves its original three metadata-only requests. That observation alone
made no search/fetch call. The subsequent SDK 0.1.6 now publishes two compiled
read tools with [two actual SDK reads](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.6-2026-10-17.json)
and [two beta 43 fetch workflows across restart](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b43-2026-10-17.json).
These are distinct executions, not retrospective metadata acceptance. The
original 4219 occurrences/4133 names and 32-name primary research checkpoint
remain historical observations; adding an adapter does not change that snapshot.

## Published SDK 0.1.7: calendars and mail

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
App20/server43 retain their historical 19-entry screenshots and receipts. Publishing a component never upgrades an installation
or enables a provider.

Common enrollment for `google_calendar`, `outlook_mail` and `outlook_calendar`
remains **off**. Google Calendar API enablement/new scopes and real consent,
Microsoft app registration/terms/real consent, and applicable provider reviews
remain gates. An operator-owned app requires its own valid registration and
qualified receiving host. See [setup and recovery](./connector-operations.md#calendar-and-mail-sdk-017)
and the [versioned SDK contract and limits](https://github.com/openagent-uno/openagent-tools/blob/main/docs/connector-calendar-mail-0.1.7-candidate.md).

## Integration paths and remaining work

Use an official MCP when its transport, authorization and provider conditions support an independent client. Use a shared API adapter when that is the supported interface. Each provider still needs its actual discovery/read/write/refresh/restart/disconnect and tenant-isolation qualification. A paid plan, partner agreement, provider review or unsupported public API is a concrete gate; copying private ChatGPT endpoints or cookies is not an integration path.

Slack's official MCP requires a Marketplace or internal app; unlisted apps are not accepted. Ahrefs documents distinct API and MCP terms, including restrictions on independent scripted MCP clients. Atlassian documents Rovo credit consumption. These constraints are recorded with primary sources in the inventory; they must be resolved before using the affected API or MCP service. Other entries need individual provider research and registration as applicable.

## Popular directory order

The table preserves the original Popular editorial order. Current Python
releases are SDK18/server45 with 114 official entries; each new token profile
has only its two documented reads. App21 remains public and App21/server44/SDK17
remains the visually qualified pair. Real provider evidence, local GUI controls
and common OAuth availability are separate. Only ClickUp/GitHub/Notion common
enrollment is open in the limited beta. App22 publication/GUI, full feature
parity and Mac/Windows marketplace GUI are not qualified here.

| Position | App | OpenAgent implementation | Verified interface |
| ---: | --- | --- | --- |
| 1 | [Remote Desktop Commander](https://chatgpt.com/plugins/plugin_asdk_app_6a057d268ebc81919918d37eec718425) | Not implemented/qualified | [Remote OAuth/PKCE MCP and device pairing](https://github.com/desktop-commander/remote-desktop-commander) |
| 2 | [Google Drive](https://chatgpt.com/plugins/plugin_connector_1p_ab21a553bfbc81919ea8fd1858e3ffa7) | Adapter exists; qualification separate | [Documented public API](https://developers.google.com/workspace/drive/api/guides/about-sdk) |
| 3 | [Flaim Fantasy](https://chatgpt.com/plugins/plugin_asdk_app_69a8f78087e081919e52cacacf00ff36) | Not implemented/qualified | [Documented custom-client OAuth MCP](https://flaim.app/docs/custom-connectors) |
| 4 | [Atlassian](https://chatgpt.com/plugins/plugin_asdk_app_6a83901dde988191b3f3cefdcc19acfa) | SDK 0.1.4/server 40 published: 9 Jira tools; secret custody and real qualification pending | [MCP with commercial conditions](https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/) |
| 5 | [WPVibe](https://chatgpt.com/plugins/plugin_asdk_app_6a244fb509e481918985fee76373b0f9) | Not implemented/qualified | [Documented independent-client OAuth MCP](https://wpvibe.ai/docs/ai-client-setup/) |
| 6 | [GitHub](https://chatgpt.com/plugins/plugin_connector_1p_1a69035c238881919c4190932b2df699) | SDK 0.1.4/server 40 published; limited standalone QA passed; App 18 published; native App provider acceptance separate; common OAuth beta open | [Documented official MCP](https://github.com/github/github-mcp-server) |
| 7 | [Health](https://chatgpt.com/plugins/plugin_connector_1p_e569f8b8dfd08191903c9bd2cd7da9ac) | Not implemented/qualified | Not researched |
| 8 | [Outlook Email](https://chatgpt.com/plugins/plugin_connector_1p_6bcb5879c73c819196abc70016166099) | SDK18/server45: 9 mail tools; separate send permission; common OAuth and real account QA pending; App21/server44 GUI remains historical | [Documented public API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0) |
| 9 | [Supabase](https://chatgpt.com/plugins/plugin_asdk_app_69d3e5ee6a708191baa733f7b8931995) | SDK18/server45: list projects and read project details; own token; real-account QA pending | [Documented official MCP](https://supabase.com/docs/guides/ai-tools/mcp) |
| 10 | [Firecrawl](https://chatgpt.com/plugins/plugin_asdk_app_6a314a73f8ac819195b0d55e36b9c609) | SDK 0.1.6/server 43/App beta 20 public; five keyless GUI controls passed on Linux x64, zero GUI provider calls; provider reads retain SDK 0.1.5/beta 41 scope | [Official keyless MCP](https://docs.firecrawl.dev/mcp-server/keyless) |
| 11 | [Windsor.ai](https://chatgpt.com/plugins/plugin_asdk_app_694a52cfaa3c819192bea84eaa254968) | Not implemented/qualified | [Official OAuth/DCR MCP](https://mcp.windsor.ai/) |
| 12 | [Exa](https://chatgpt.com/plugins/plugin_asdk_app_69ea4ed2cf7c8191b742ef3622479ddd) | SDK 0.1.6/server 43/App beta 20 public; five keyless GUI controls passed on Linux x64, zero GUI provider calls; provider reads retain SDK 0.1.5/beta 41 scope | [Official keyless MCP](https://exa.ai/docs/get-started/exa-mcp) |
| 13 | [Render](https://chatgpt.com/plugins/plugin_asdk_app_6a624c56bfe081918f7544f7d58f6faf) | SDK18/server45: list services and review their deployments; own token; real-account QA pending | [Documented official MCP](https://render.com/docs/mcp-server) |
| 14 | [Upwork](https://chatgpt.com/plugins/plugin_asdk_app_6a75165ed2d8819182548553aa4cb6d5) | Not implemented/qualified | [Official MCP guide](https://www.upwork.com/ai/mcp); [vendor manifest](https://github.com/upwork/upwork-agent-plugin/blob/master/mcp.json) |
| 15 | [Notion](https://chatgpt.com/plugins/plugin_asdk_app_69c18c28f1188191bf5b8445c4ab0a2e) | SDK 0.1.4/server 40 published; single-page QA passed; App 18 published; native App provider acceptance separate; common OAuth beta open | [Documented official MCP](https://developers.notion.com/guides/mcp/overview) |
| 16 | [Slack](https://chatgpt.com/plugins/plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d) | SDK 0.1.4/server 40 published; limited lifecycle passed; App 18 published; native App provider acceptance and enrollment pending | [MCP subject to approval/distribution](https://docs.slack.dev/ai/slack-mcp-server/); [Documented public API](https://docs.slack.dev/apis/) |
| 17 | [Parallel Search](https://chatgpt.com/plugins/plugin_asdk_app_69fb9378663481919a68e8a2109644e5) | SDK 0.1.6/server 43/App beta 20 public; two SDK reads and beta 43 fetch/restart/disconnect lifecycle passed; Linux x64 local controls passed | [Official public Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) |
| 18 | [Shopify](https://chatgpt.com/plugins/plugin_asdk_app_69e65c430b3081919aa4d962ab5d1698) | Adapter exists; common OAuth disabled | [Documented public API](https://shopify.dev/docs/api/admin-graphql/latest) |
| 19 | [Granola](https://chatgpt.com/plugins/plugin_asdk_app_697761cab6f48191b5ed345919a3ce8b) | Not implemented/qualified | [Official OAuth/DCR MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp) |
| 20 | [Klaviyo](https://chatgpt.com/plugins/plugin_asdk_app_694421e60cc88191a1e5bb4aa79950e4) | SDK18/server45: list customer profiles and marketing campaigns; own token; real-account QA pending | [Documented public API](https://developers.klaviyo.com/en/reference/api_overview) |
| 21 | [SentinelX](https://chatgpt.com/plugins/plugin_asdk_app_69f63e01766881919640f03b5e7912a5) | Not implemented/qualified | Not researched |
| 22 | [TinyFish](https://chatgpt.com/plugins/plugin_asdk_app_695325bae7348191b58ae9349a963d22) | Not implemented/qualified | Not researched |
| 23 | [Wispr Flow](https://chatgpt.com/plugins/plugin_asdk_app_6a5ae9736be0819199d06d61ac171080) | Not implemented/qualified | Not researched |
| 24 | [Canva](https://chatgpt.com/plugins/plugin_connector_68df33b1a2d081918778431a9cfca8ba) | SDK18/server45: list designs and read design details; own token; real-account QA pending | [Documented public API](https://www.canva.dev/docs/apps/rest-apis/) |
| 25 | [Railway](https://chatgpt.com/plugins/plugin_asdk_app_6a502589384081919c5decf93496c9d1) | SDK18/server45: read your account profile and project details; own token; real-account QA pending | [Documented official MCP](https://docs.railway.com/ai/mcp-server) |
| 26 | [Adspirer](https://chatgpt.com/plugins/plugin_asdk_app_69461dc91ee48191ae4a14eb9bde1c21) | Not implemented/qualified | Not researched |
| 27 | [Vercel](https://chatgpt.com/plugins/plugin_connector_690a90ec05c881918afb6a55dc9bbaa1) | SDK18/server45: list projects and deployments; own token; real-account QA pending | [Documented official MCP](https://vercel.com/docs/agent-resources/vercel-mcp) |
| 28 | [Otter.ai](https://chatgpt.com/plugins/plugin_asdk_app_695d84e2f06c8191861b9bac9b3fd53b) | Not implemented/qualified | Not researched |
| 29 | [GitLab (Beta)](https://chatgpt.com/plugins/plugin_connector_1p_5925693c1aa88191a4959257e60d0734) | SDK18/server45: list projects and project issues; own token; real-account QA pending | [Documented official MCP](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) |
| 30 | [HubSpot](https://chatgpt.com/plugins/plugin_asdk_app_697acb8e53d88191bf7a79e62012ae14) | SDK18/server45: list contacts and companies; own token; real-account QA pending | [Documented official MCP](https://developers.hubspot.com/ai-tools/mcp) |
| 31 | [GSC Wizard](https://chatgpt.com/plugins/plugin_asdk_app_6a258ab1e0908191aa647c33299ad14c) | Not implemented/qualified | Not researched |
| 32 | [vidIQ](https://chatgpt.com/plugins/plugin_asdk_app_69dd11f3e50c8191b1ca48d03cf7e2ad) | Not implemented/qualified | Not researched |
| 33 | [Asana](https://chatgpt.com/plugins/plugin_asdk_app_69616780bd208191b4fb44ba44f72b61) | SDK18/server45: list projects and tasks; own token; real-account QA pending | [Documented public API](https://developers.asana.com/docs/overview) |
| 34 | [Metricool](https://chatgpt.com/plugins/plugin_asdk_app_69d73fc8aa5c8191bec1583760b130c7) | Not implemented/qualified | Not researched |
| 35 | [Superhuman Mail](https://chatgpt.com/plugins/plugin_asdk_app_69a21e4058dc8191a6220fa911310d7b) | Not implemented/qualified | Not researched |
| 36 | [IOL invertironline](https://chatgpt.com/plugins/plugin_asdk_app_6a207f00eed0819181227b2ea257ff0b) | Not implemented/qualified | Not researched |
| 37 | [Fathom](https://chatgpt.com/plugins/plugin_asdk_app_69d88b99c5c481918e8da9225737e1e9) | SDK18/server45: list meetings and read recording transcripts; own token; real-account QA pending | [Documented read API](https://developers.fathom.ai/quickstart) |
| 38 | [Fireflies](https://chatgpt.com/plugins/plugin_connector_6912075cb358819187346bcafb601db8) | SDK18/server45: list meeting transcripts and read transcript details; own token; real-account QA pending | [Documented read API](https://docs.fireflies.ai/fundamentals/authorization) |
| 39 | [ClickUp](https://chatgpt.com/plugins/plugin_asdk_app_69431e6d26b88191b4029488aeb42f5b) | Adapter exists; limited lifecycle recorded; common OAuth beta open | [Documented public API](https://developer.clickup.com/) |
| 40 | [Interactive Brokers (IBKR)](https://chatgpt.com/plugins/plugin_asdk_app_69bc11db874881918718abaca20b68ce) | Not implemented/qualified | Not researched |
| 41 | [Todoist: To Do List & Calendar](https://chatgpt.com/plugins/plugin_asdk_app_6943b73823548191a9f9216c6790c453) | SDK18/server45: list projects and tasks; own token; real-account QA pending | [Documented read API](https://developer.todoist.com/api/v1/) |
| 42 | [Opera Browser Connector](https://chatgpt.com/plugins/plugin_asdk_app_69d669e1d5c88191957786fbcd38b411) | Not implemented/qualified | Not researched |
| 43 | [Ahrefs](https://chatgpt.com/plugins/plugin_asdk_app_6966958473488191b775fdb667c52eab) | SDK18/server45: read domain ratings and SEO metrics; own token; real-account QA pending | [Commercial MCP with client restrictions](https://docs.ahrefs.com/en/mcp/docs/introduction); [API on commercial plan](https://docs.ahrefs.com/en/api/docs/introduction) |
| 44 | [monday.com](https://chatgpt.com/plugins/plugin_connector_690aabb71bf481918b8d5b614ed3fd4c) | SDK18/server45: list boards and read board items; own token; real-account QA pending | [Documented public API](https://developer.monday.com/api-reference/docs/basics) |
| 45 | [Tredict](https://chatgpt.com/plugins/plugin_asdk_app_69aef5b699a0819184512d57743fc1cd) | Not implemented/qualified | Not researched |
| 46 | [Webflow](https://chatgpt.com/plugins/plugin_asdk_app_6a0783a98c4c8191841404d786d4a4b9) | SDK18/server45: list sites and their collections; own token; real-account QA pending | [Documented public API](https://developers.webflow.com/data/reference/rest-introduction) |
| 47 | [HYPD AI - Paid Ads & Analytics](https://chatgpt.com/plugins/plugin_asdk_app_6a3170ea7fc88191be6c0b9ff250a4b4) | Not implemented/qualified | Not researched |
| 48 | [SharePoint](https://chatgpt.com/plugins/plugin_connector_1p_dca009ae2c848191ae14df3a47c5e7fd) | SDK18/server45: 7 read tools and verified site/library selection; common OAuth and real account QA pending | [Documented public API](https://learn.microsoft.com/en-us/graph/api/resources/sharepoint?view=graph-rest-1.0) |
| 49 | [Floot](https://chatgpt.com/plugins/plugin_asdk_app_6a500d350f8c819194e30335a7b134af) | Not implemented/qualified | Not researched |
| 50 | [Quo](https://chatgpt.com/plugins/plugin_asdk_app_69e6af3297d88191b4925772c50df286) | SDK18/server45: list phone numbers and conversations; own token; real-account QA pending | [Documented read API](https://www.quo.com/docs/api-reference/introduction/authentication) |
