# ChatGPT app coverage and expansion

Recorded **16 October 2026**. OpenAgent is expanding its shared connector library across the publicly visible ChatGPT app directory. The observation includes **16 category pages, 4,219 card occurrences and 4,133 distinct display names**. Names are not unique provider identities: different app IDs can share a name, and the visible directory varies by date, region and account.

The directory does not publish adoption counts. The first 50 positions below preserve its editorial **Popular** order; they are not measured usage rankings. Services outside Popular remain in the full inventory. Publication in ChatGPT does not establish an API/MCP available to independent clients, transferable OAuth credentials, commercial eligibility or feature parity.

The complete [readable inventory](https://github.com/openagent-uno/openagent-tools/blob/main/docs/chatgpt-app-coverage.md) and [machine-readable snapshot](https://github.com/openagent-uno/openagent-tools/blob/main/docs/chatgpt-app-coverage.json) preserve all observed category occurrences and provider research. Unresearched entries are explicitly unknown, rather than claimed unavailable APIs.

## First implementation batch: GitHub and Notion

**SDK/runner 0.1.4 is published.** The [qualified shared prerelease](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.4) contains the GitHub, Notion, Slack and Jira adapters. Server/CLI beta 40 adopts this library; other installed products retain their own version pins until updated. The two provider registrations were created under OpenAgent; app secrets are held in encrypted production storage. Common enrollment remains disabled. GitHub and Notion completed the limited authorized standalone QA lifecycles described below. Registration and source fixtures alone do not prove real access.

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
remaining tools, native App acceptance, receiving-product release/adoption and general
enrollment remain pending.

## GitHub real-provider QA

On 16 October, a private standalone source candidate completed GitHub OAuth,
repository reading, creation/reading/closure of a disposable issue, explicit
owner refresh, a read after server restart, and local disconnection. The app was
installed only on an explicitly approved private QA repository with Actions
disabled. API calls ran on the receiving server; no language model was used.
The temporary server was removed after disconnecting.

The [lifecycle receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/github-oauth-2026-10-16.json)
records exact source and dependency pins. Native App acceptance, remaining
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

The Atlassian app and callback are registered, with secret custody still pending. Slack's OpenAgent app, callback, ten user scopes and token rotation are saved, with its secret in encrypted production storage; one authorized receiving installation completed the limited lifecycle below. Neither provider is enabled for common enrollment. [Primary Slack rate-limit reference](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) and [Atlassian OAuth reference](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) describe the provider constraints.

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
The shared 0.1.4 artifacts are now published. Remaining tools, native App acceptance,
receiving-product release/adoption and general enrollment remain separate. This does not qualify Slack's separate
MCP service or provider-wide app revocation.

### Candidate setup and renewal

After a qualified runner and receiving-product release, connect these providers from the same marketplace cards. For Jira, complete OAuth and choose a site from the server-returned list. The candidate App offers **Choose Jira site**; the authenticated CLI offers `connectors sites <connection-id>` and `connectors select-site <connection-id> <cloud-id>`. The server rechecks the current provider grant on every site change and invalidates old tool references.

The candidate App also provides **Refresh access**, backed by `POST /api/connectors/{id}/refresh` and `connectors refresh <connection-id>`. This owner-authorized operation is useful when a provider supplies a refresh token without an expiry, as documented for Notion. It does not invent a token lifetime or replace consent. Connections without a refresh credential require reconnection. The server serializes renewal, rechecks consent/permissions after I/O and atomically saves the latest pair. These actions ship in server/CLI beta 40. App beta 18 adds their graphical controls and is being qualified separately; the current App beta 17 does not expose them.

## Integration paths and remaining work

Use an official MCP when its transport, authorization and provider conditions support an independent client. Use a shared API adapter when that is the supported interface. Each provider still needs its actual discovery/read/write/refresh/restart/disconnect and tenant-isolation qualification. A paid plan, partner agreement, provider review or unsupported public API is a concrete gate; copying private ChatGPT endpoints or cookies is not an integration path.

Slack's official MCP requires a Marketplace or internal app; unlisted apps are not accepted. Ahrefs documents distinct API and MCP terms, including restrictions on independent scripted MCP clients. Atlassian documents Rovo credit consumption. These constraints are recorded with primary sources in the inventory; they must be resolved before enabling those providers. Other entries need individual provider research and registration as applicable.

## Popular directory order

The table preserves the initial Popular directory order, with implementation status updated for SDK 0.1.4 and server/CLI beta 40. It is not a public enrollment claim.

| Position | App | OpenAgent baseline | Verified interface |
| ---: | --- | --- | --- |
| 1 | [Remote Desktop Commander](https://chatgpt.com/plugins/plugin_asdk_app_6a057d268ebc81919918d37eec718425) | Not implemented/qualified | Not researched |
| 2 | [Google Drive](https://chatgpt.com/plugins/plugin_connector_1p_ab21a553bfbc81919ea8fd1858e3ffa7) | Adapter exists; qualification separate | [Documented public API](https://developers.google.com/workspace/drive/api/guides/about-sdk) |
| 3 | [Flaim Fantasy](https://chatgpt.com/plugins/plugin_asdk_app_69a8f78087e081919e52cacacf00ff36) | Not implemented/qualified | Not researched |
| 4 | [Atlassian](https://chatgpt.com/plugins/plugin_asdk_app_6a83901dde988191b3f3cefdcc19acfa) | SDK 0.1.4/server 40 published: 9 Jira tools; secret custody and real qualification pending | [MCP with commercial conditions](https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/) |
| 5 | [WPVibe](https://chatgpt.com/plugins/plugin_asdk_app_6a244fb509e481918985fee76373b0f9) | Not implemented/qualified | Not researched |
| 6 | [GitHub](https://chatgpt.com/plugins/plugin_connector_1p_1a69035c238881919c4190932b2df699) | SDK 0.1.4/server 40 published; limited standalone QA passed; App and enrollment pending | [Documented official MCP](https://github.com/github/github-mcp-server) |
| 7 | [Health](https://chatgpt.com/plugins/plugin_connector_1p_e569f8b8dfd08191903c9bd2cd7da9ac) | Not implemented/qualified | Not researched |
| 8 | [Outlook Email](https://chatgpt.com/plugins/plugin_connector_1p_6bcb5879c73c819196abc70016166099) | Not implemented/qualified | [Documented public API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0) |
| 9 | [Supabase](https://chatgpt.com/plugins/plugin_asdk_app_69d3e5ee6a708191baa733f7b8931995) | Not implemented/qualified | [Documented official MCP](https://supabase.com/docs/guides/ai-tools/mcp) |
| 10 | [Firecrawl](https://chatgpt.com/plugins/plugin_asdk_app_6a314a73f8ac819195b0d55e36b9c609) | Not implemented/qualified | [Documented official MCP](https://docs.firecrawl.dev/mcp-server) |
| 11 | [Windsor.ai](https://chatgpt.com/plugins/plugin_asdk_app_694a52cfaa3c819192bea84eaa254968) | Not implemented/qualified | Not researched |
| 12 | [Exa](https://chatgpt.com/plugins/plugin_asdk_app_69ea4ed2cf7c8191b742ef3622479ddd) | Not implemented/qualified | [Documented official MCP](https://exa.ai/docs/get-started/exa-mcp) |
| 13 | [Render](https://chatgpt.com/plugins/plugin_asdk_app_6a624c56bfe081918f7544f7d58f6faf) | Not implemented/qualified | [Documented official MCP](https://render.com/docs/mcp-server) |
| 14 | [Upwork](https://chatgpt.com/plugins/plugin_asdk_app_6a75165ed2d8819182548553aa4cb6d5) | Not implemented/qualified | Not researched |
| 15 | [Notion](https://chatgpt.com/plugins/plugin_asdk_app_69c18c28f1188191bf5b8445c4ab0a2e) | SDK 0.1.4/server 40 published; single-page QA passed; App and enrollment pending | [Documented official MCP](https://developers.notion.com/guides/mcp/overview) |
| 16 | [Slack](https://chatgpt.com/plugins/plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d) | SDK 0.1.4/server 40 published; limited lifecycle passed; App and enrollment pending | [MCP subject to approval/distribution](https://docs.slack.dev/ai/slack-mcp-server/); [Documented public API](https://docs.slack.dev/apis/) |
| 17 | [Parallel Search](https://chatgpt.com/plugins/plugin_asdk_app_69fb9378663481919a68e8a2109644e5) | Not implemented/qualified | Not researched |
| 18 | [Shopify](https://chatgpt.com/plugins/plugin_asdk_app_69e65c430b3081919aa4d962ab5d1698) | Adapter exists; common OAuth disabled | [Documented public API](https://shopify.dev/docs/api/admin-graphql/latest) |
| 19 | [Granola](https://chatgpt.com/plugins/plugin_asdk_app_697761cab6f48191b5ed345919a3ce8b) | Not implemented/qualified | Not researched |
| 20 | [Klaviyo](https://chatgpt.com/plugins/plugin_asdk_app_694421e60cc88191a1e5bb4aa79950e4) | Not implemented/qualified | [Documented public API](https://developers.klaviyo.com/en/reference/api_overview) |
| 21 | [SentinelX](https://chatgpt.com/plugins/plugin_asdk_app_69f63e01766881919640f03b5e7912a5) | Not implemented/qualified | Not researched |
| 22 | [TinyFish](https://chatgpt.com/plugins/plugin_asdk_app_695325bae7348191b58ae9349a963d22) | Not implemented/qualified | Not researched |
| 23 | [Wispr Flow](https://chatgpt.com/plugins/plugin_asdk_app_6a5ae9736be0819199d06d61ac171080) | Not implemented/qualified | Not researched |
| 24 | [Canva](https://chatgpt.com/plugins/plugin_connector_68df33b1a2d081918778431a9cfca8ba) | Not implemented/qualified | [Documented public API](https://www.canva.dev/docs/apps/rest-apis/) |
| 25 | [Railway](https://chatgpt.com/plugins/plugin_asdk_app_6a502589384081919c5decf93496c9d1) | Not implemented/qualified | [Documented official MCP](https://docs.railway.com/ai/mcp-server) |
| 26 | [Adspirer](https://chatgpt.com/plugins/plugin_asdk_app_69461dc91ee48191ae4a14eb9bde1c21) | Not implemented/qualified | Not researched |
| 27 | [Vercel](https://chatgpt.com/plugins/plugin_connector_690a90ec05c881918afb6a55dc9bbaa1) | Not implemented/qualified | [Documented official MCP](https://vercel.com/docs/agent-resources/vercel-mcp) |
| 28 | [Otter.ai](https://chatgpt.com/plugins/plugin_asdk_app_695d84e2f06c8191861b9bac9b3fd53b) | Not implemented/qualified | Not researched |
| 29 | [GitLab (Beta)](https://chatgpt.com/plugins/plugin_connector_1p_5925693c1aa88191a4959257e60d0734) | Not implemented/qualified | [Documented official MCP](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) |
| 30 | [HubSpot](https://chatgpt.com/plugins/plugin_asdk_app_697acb8e53d88191bf7a79e62012ae14) | Not implemented/qualified | [Documented official MCP](https://developers.hubspot.com/ai-tools/mcp) |
| 31 | [GSC Wizard](https://chatgpt.com/plugins/plugin_asdk_app_6a258ab1e0908191aa647c33299ad14c) | Not implemented/qualified | Not researched |
| 32 | [vidIQ](https://chatgpt.com/plugins/plugin_asdk_app_69dd11f3e50c8191b1ca48d03cf7e2ad) | Not implemented/qualified | Not researched |
| 33 | [Asana](https://chatgpt.com/plugins/plugin_asdk_app_69616780bd208191b4fb44ba44f72b61) | Not implemented/qualified | [Documented public API](https://developers.asana.com/docs/overview) |
| 34 | [Metricool](https://chatgpt.com/plugins/plugin_asdk_app_69d73fc8aa5c8191bec1583760b130c7) | Not implemented/qualified | Not researched |
| 35 | [Superhuman Mail](https://chatgpt.com/plugins/plugin_asdk_app_69a21e4058dc8191a6220fa911310d7b) | Not implemented/qualified | Not researched |
| 36 | [IOL invertironline](https://chatgpt.com/plugins/plugin_asdk_app_6a207f00eed0819181227b2ea257ff0b) | Not implemented/qualified | Not researched |
| 37 | [Fathom](https://chatgpt.com/plugins/plugin_asdk_app_69d88b99c5c481918e8da9225737e1e9) | Not implemented/qualified | Not researched |
| 38 | [Fireflies](https://chatgpt.com/plugins/plugin_connector_6912075cb358819187346bcafb601db8) | Not implemented/qualified | Not researched |
| 39 | [ClickUp](https://chatgpt.com/plugins/plugin_asdk_app_69431e6d26b88191b4029488aeb42f5b) | Adapter exists; qualification separate | [Documented public API](https://developer.clickup.com/) |
| 40 | [Interactive Brokers (IBKR)](https://chatgpt.com/plugins/plugin_asdk_app_69bc11db874881918718abaca20b68ce) | Not implemented/qualified | Not researched |
| 41 | [Todoist: To Do List & Calendar](https://chatgpt.com/plugins/plugin_asdk_app_6943b73823548191a9f9216c6790c453) | Not implemented/qualified | Not researched |
| 42 | [Opera Browser Connector](https://chatgpt.com/plugins/plugin_asdk_app_69d669e1d5c88191957786fbcd38b411) | Not implemented/qualified | Not researched |
| 43 | [Ahrefs](https://chatgpt.com/plugins/plugin_asdk_app_6966958473488191b775fdb667c52eab) | Not implemented/qualified | [Commercial MCP with client restrictions](https://docs.ahrefs.com/en/mcp/docs/introduction); [API on commercial plan](https://docs.ahrefs.com/en/api/docs/introduction) |
| 44 | [monday.com](https://chatgpt.com/plugins/plugin_connector_690aabb71bf481918b8d5b614ed3fd4c) | Not implemented/qualified | [Documented public API](https://developer.monday.com/api-reference/docs/basics) |
| 45 | [Tredict](https://chatgpt.com/plugins/plugin_asdk_app_69aef5b699a0819184512d57743fc1cd) | Not implemented/qualified | Not researched |
| 46 | [Webflow](https://chatgpt.com/plugins/plugin_asdk_app_6a0783a98c4c8191841404d786d4a4b9) | Not implemented/qualified | [Documented public API](https://developers.webflow.com/data/reference/rest-introduction) |
| 47 | [HYPD AI - Paid Ads & Analytics](https://chatgpt.com/plugins/plugin_asdk_app_6a3170ea7fc88191be6c0b9ff250a4b4) | Not implemented/qualified | Not researched |
| 48 | [SharePoint](https://chatgpt.com/plugins/plugin_connector_1p_dca009ae2c848191ae14df3a47c5e7fd) | Not implemented/qualified | [Documented public API](https://learn.microsoft.com/en-us/graph/api/resources/sharepoint?view=graph-rest-1.0) |
| 49 | [Floot](https://chatgpt.com/plugins/plugin_asdk_app_6a500d350f8c819194e30335a7b134af) | Not implemented/qualified | Not researched |
| 50 | [Quo](https://chatgpt.com/plugins/plugin_asdk_app_69e6af3297d88191b4925772c50df286) | Not implemented/qualified | Not researched |
