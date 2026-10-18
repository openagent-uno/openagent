# Using connectors

::: info Published releases and activation gates
Current published Python components are **SDK/runner 0.1.8 and server/CLI beta45**,
with **114 official connectors plus Custom MCP**. [Server45 is public](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.45)
from `0049bfd95cf722784c835897ce6175a6690a1bc1`; its installed qualification passed
210 installed tests and 15 separate React component source scenarios. The new SDK adds 90 token-based connectors
with two read tools each, plus read-only OneDrive and SharePoint.

**App beta21 remains the published App.** The visually qualified pair below is
App21/server44/SDK17: 22 official entries and 30 real registry results in one
grid, 12 loaded local marks and five local keyless control cycles. App22/server45
publication and actual GUI qualification are pending; the existing screenshots
are not evidence of the new 114-entry marketplace. Mac/Windows marketplace GUI
and hosted sandbox security remain separate.

Common OAuth enrollment remains a limited public beta for ClickUp, GitHub and
Notion. Every connection needs local authorization and provider consent.
Google/Microsoft common enrollment and real-provider acceptance are not enabled
by these releases. Slack distribution, Jira registration/consent, Shopify
privacy/provider gates and Postiz credential rotation retain their separate
boundaries. Token credentials require the provider's actual permissions; saving
a connection is not proof of a successful API call. See [remaining gates](./connector-status.md).
Older installations retain their version pins until explicitly updated.
:::

OpenAgent provides one shared connector implementation for the standalone server and independent host products that embed it. Your product server stores encrypted credentials and makes normal API calls directly to the provider. Accounts, agent history, files and customer databases remain with that product.

The shared authentication service accepts ClickUp, GitHub and Notion enrollment. On released server beta 40, operators enable these providers with `connectors.official_providers: [clickup, github, notion]` or `OPENAGENT_CONNECTOR_AUTH_PROVIDERS=clickup,github,notion`. Server beta 43 defaults to those three only when neither setting is supplied. An explicit empty list or empty environment value remains an opt-out; listing a provider creates no connection, broker registration or grant. Every OAuth connection still requires local authorization and the provider's consent. See the [configuration precedence](./connector-operations.md#standalone-configuration). Shopify enrollment is currently disabled: the published opt-in privacy processor covers a fresh canonical text-history cohort, with additional storage and real-provider acceptance gates still required. Existing tokens retain their original OAuth registration. The legacy ClickUp callback has been removed by the operator; a new ClickUp consent must use the shared app callback.

## Token connectors and Microsoft files

[SDK 0.1.8](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.8)
and [server/CLI45](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.45)
publish 114 official integrations plus Custom MCP. The 90 new token connectors
provide two specific reads each: for example, Coda profile/document details,
Postman collection list/details, and Cloudflare zones/accounts. See the
[provider API profiles](./connector-api-profiles.md) and the
[versioned catalog](https://github.com/openagent-uno/openagent-tools/releases/download/connectors-v0.1.8/catalog.json)
for each connector's operations and setup guidance.

Use a dedicated API/access token authorized for those reads. The receiving
server encrypts it locally; the provider checks its real permissions. These
connections do not fabricate OAuth grants or promise automatic token renewal.
Documented response fixtures and installed tests qualify the implementation;
no real-account acceptance is claimed for all 90 providers. App22 adds the
shared setup guidance and 45 shared provider marks, but its public native
release and actual GUI checks remain pending.

OneDrive has five read tools for existing drives, file metadata, folder items
and bounded file contents. SharePoint has seven, adding site search/details and
site-bound document libraries. There are no file writes or automatic OneDrive
provisioning. Each Microsoft account has a separate OAuth connection. After an
operator configures a valid OAuth app and the account authorizes it, select the
site first for SharePoint, then select its document library; for OneDrive,
select an existing drive. Only a fresh authorized resource-list result can set
the binding. Model arguments cannot choose another site, drive or download URL.

OneDrive requests delegated `Files.Read` with identity/renewal scopes;
SharePoint requests explicit `Sites.Read.All`, which is broader than access to
one selected site. The local selection narrows tool use; it does not narrow
the provider's consent. `Sites.Selected` is not silently replaced by a broader
grant. Common Microsoft enrollment and real OAuth/file-read qualification remain
pending. The CLI uses the same owner-authorized server resource selection:

```sh
openagent-cli connectors microsoft-resources <connection-id> --kind drives --json
openagent-cli connectors select-microsoft-drive <connection-id> <drive-id>
# SharePoint: search and select a site before listing its drives.
openagent-cli connectors microsoft-resources <connection-id> --kind sites --query Research --json
openagent-cli connectors select-microsoft-site <connection-id> <site-id> --query Research
```

Use the same `--page-token` when selecting a resource from a later page. After
selection, list again from page one: resource tokens are bound to the connection,
account, credential generation and current selection.

## Calendar and mail SDK availability

[SDK 0.1.7 is public](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.7)
with 22 official connectors plus Custom MCP, including Google Calendar (7 tools),
Outlook Mail (9) and Outlook Calendar (7). The [SDK receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/calendar-mail-sdk-0.1.7-2026-10-17.json) qualifies
code, packages and isolated protocol fixtures. Real Google/Microsoft OAuth and
provider operations remain pending, and common enrollment for these providers
is closed. [Server/CLI44 is public](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.44)
with 22 entries and [installed Python qualification](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/calendar-mail-product-1.1.0b44-2026-10-17.json). The [fresh public installer44](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product44-public-installer-2026-10-17.json) passed combined server/CLI installation, dependency/version checks and the installed 22-plus-Custom catalog, with no source overlay or HOME/TMPDIR override and no server/model start or provider call.
[App21 is public](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.21) with six native targets and 36 verified assets; [App21/server44 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json) passed; the current screenshots show App21/server44, with historical App20/server43 evidence retained below.

After a receiving host adopts and qualifies SDK17 and an operator configures an
approved OAuth app, each account uses a separate connection through the same
marketplace/API/CLI controls. Read access, local permission to change data and
provider scopes remain independent. Outlook sending additionally requires
`Mail.Send`; preparing a draft does not send it. See [Calendar/mail setup and
recovery](./connector-operations.md#calendar-and-mail-sdk-017) for scopes,
account binding and the bounded first-release operations.

## Shared components

The [architecture guide](./shared-components.md) explains which parts are
shared and which stay in the receiving product. Operators can use the
[setup and recovery guide](./connector-operations.md).

## Connector library

For the expanding typed API subset, token setup and its qualification boundary,
see [shared provider API profiles](./connector-api-profiles.md).

The [ChatGPT app coverage guide](./chatgpt-apps.md) preserves the complete
observed directory and its editorial Popular order. Published SDK 0.1.8 contains
114 implemented official adapters plus Custom MCP, consumed by server/CLI45.
Library publication is separate from provider activation and each receiving
host's rollout. See the [SDK read receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.6-2026-10-17.json),
[normal product lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b43-2026-10-17.json)
and [App 20 GUI receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json)
for their exact limits. These do not establish full ChatGPT feature parity.

| Connector | Authentication | Shared implementation |
| --- | --- | --- |
| OneDrive | OAuth | Existing drives, folder items, file metadata and bounded file contents; 5 read tools; explicit drive selection |
| SharePoint | OAuth | Authorized site search/details, site-bound document libraries and bounded file reads; 7 read tools |
| Google Calendar | OAuth | CalendarList and events; 7 tools with local write admission and version checks |
| Outlook Mail | OAuth | Folders, messages, attachments and drafts; sending requires separate permission; 9 tools |
| Outlook Calendar | OAuth | Calendars and events; 7 tools with finite UTC writes and version checks |
| 90 provider API profiles | Dedicated API/access token | Two concrete reads per provider, with setup guidance and provider-enforced permissions |
| Shopify | OAuth | Products, orders, inventory and permitted store operations |
| Gmail | OAuth | Messages, threads, attachments, drafts and sending |
| Google Drive | OAuth | Search, files, folders and permitted file operations |
| Google Analytics | OAuth | Read-only GA4 reports and metadata |
| ClickUp | OAuth | Tasks, workspaces, Docs, Goals and time tracking |
| Postiz | OAuth | Social integrations, analytics, drafts and publishing; registered app remains disabled pending credential rotation and qualification |
| Pipeboard Ads | API token | Meta/Google Ads reports and permitted campaign pause |
| Replio | Organization API token | Apps, conversations and support statistics |
| BillingBear | Project API token | Revenue and customer billing information |
| IMAP Email | Local account/app passwords | Read messages and send through SMTP over TLS |
| GitHub | GitHub App OAuth | Selected repositories, code and pull-request reads, issues/comments; 17 operations |
| Notion | Public OAuth with selected pages | Search, pages, blocks and profiles; 8 operations |
| Slack | Confidential user OAuth | Conversations/history, profiles and text post/update/delete; 9 operations |
| Atlassian / Jira | Resource-level OAuth and verified site selection | Projects, JQL search, issues and comments; 9 operations; secret custody/consent pending |
| Exa | Keyless, no account or API key | Public search/fetch; 2 read tools; limited product fetch lifecycle on beta 41 |
| Firecrawl | Keyless, no account or API key | Public search/Markdown scrape; 2 read tools; limited product scrape lifecycle on beta 41 |
| Parallel Search | Keyless, no account or API key | Public search/excerpt fetch; 2 read tools; fetch workflow/restart/disconnect on beta 43 |
| Context7 | Keyless, no account or API key | Resolve library IDs and query public docs; 2 read tools; query workflow/restart/disconnect on beta 43 |
| CoinGecko | Keyless, no account or API key | Bounded public prices/global aggregates; 2 read tools; global workflow/restart/disconnect on beta 43 |

Custom MCP servers remain available alongside official connectors. Embedding products retain their own controls over who may install connectors, which agents may use them, and whether they may make changes.

## Connect and disconnect

In the App connected to an updated server, or a receiving product with the
shared catalog enabled:

1. Select the receiving server and authenticated user first. In the App, open
   **Connectors → Browse**; the same search/grid contains provider integrations
   and registry MCPs, with no dedicated official category.
2. Select **Install** on the provider card. Unavailable cards explain the
   current reason. Registry MCPs keep their normal install/configuration path; review the chosen endpoint or package.
3. For OAuth, inspect the receiving installation and requested permissions in
   the consent flow, then complete the provider's consent. Your server retrieves
   the result through outgoing requests.
4. For token/account authentication, enter the dedicated API key or account/app
   password on the receiving server's setup screen. Never put it in a chat.
   With published server beta 43 and App beta 20, the five keyless providers use the same
   card's **Install → Connect** flow without a token prompt or OAuth page.
5. Open **Manage** on the connected card to enable/disable tools, authorize
   changes where the integration supports them, reconnect or disconnect locally.

Read/write controls govern product tool admission. Provider OAuth scopes may
be broader; a local read-only choice does not rewrite the provider's grant.
A token connection being saved as Connected does not prove a successful
provider API call; verify access with an appropriate authorized operation.

![App21/server44 shared marketplace grid](/connectors/app21-server44-marketplace-top.png)

![App21/server44 registry and provider cards](/connectors/app21-server44-marketplace-scroll.png)

![Exa local controls](/connectors/app21-server44-exa-connected.png)

![Firecrawl local controls](/connectors/app21-server44-firecrawl-connected.png)

![Parallel Search local controls](/connectors/app21-server44-parallel-search-connected.png)

![Context7 local controls](/connectors/app21-server44-context7-connected.png)

![CoinGecko local controls](/connectors/app21-server44-coingecko-connected.png)

![Google Calendar card and local mark](/connectors/app21-server44-google-calendar-visible.png)

![Outlook Mail and Outlook Calendar cards and local marks](/connectors/app21-server44-outlook-mail-visible.png)

These actual Linux x64 App21/server44 screenshots use ordinary UI/SRP, device certification and native Iroh. The catalog contains 22 official entries and 30 real registry results in one grid, without an official tab, label or divider; 12 local marks passed load/DOM checks. Five keyless providers passed local Connect, disable/re-enable and disconnect without provider calls or model turns. Three additional image files target Calendar/Outlook in two unique views; the [Outlook Calendar capture](/connectors/app21-server44-outlook-calendar-visible.png) is byte-identical to the Outlook Mail view because both cards are fully visible together. The [App21/server44 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json) receipt records hashes, visual review and exact owned cleanup. Hosted `--no-sandbox` does not qualify sandbox security, Mac/Windows GUI or real Google/Microsoft access.

::: details Historical App20/server43 screenshots and scope

![App 20/server 43: official connectors and registry MCPs share the same marketplace cards](/connectors/app20-server43-marketplace-top.png)

![App 20/server 43: provider marks and registry entries in the mixed grid](/connectors/app20-server43-marketplace-scroll.png)

![Exa connected without a credential form](/connectors/app20-server43-exa-connected.png)

![Firecrawl connected without OAuth controls](/connectors/app20-server43-firecrawl-connected.png)

![Parallel Search local connection controls](/connectors/app20-server43-parallel-search-connected.png)

![Context7 local connection controls](/connectors/app20-server43-context7-connected.png)

![CoinGecko local connection controls](/connectors/app20-server43-coingecko-connected.png)

These actual Linux x64 screenshots show the public App 20 and server 43,
joined through ordinary UI/SRP, device certification and native Iroh. The
marketplace loaded 19 official entries and 30 real registry results without an
official tab, label or divider; nine bundled provider marks were verified.
All five keyless providers passed Connect, disable/re-enable and disconnect,
without credential forms, OAuth pages, provider calls or a model. Owned
process and staging cleanup passed. The [visual receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json)
records exact bytes, image review and the separately corrected cleanup guard.
Hosted `--no-sandbox` does not qualify sandbox security, Mac/Windows GUI or
provider tool parity. Earlier [App 19/server 42](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
and [App 18/server 40](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app18-server40-marketplace-2026-10-16.json)
screenshots and failures remain historical and unchanged.

:::

::: details Historical App beta 17 / server beta 39 screenshots

![Released App beta 17 with server beta 39: BillingBear shares the marketplace grid with registry MCPs](/connectors/app17-server39-marketplace-top.png)

![Released App beta 17 with server beta 39: ClickUp, Gmail and Google Analytics use the same cards alongside registry MCPs](/connectors/app17-server39-marketplace-scroll.png)

These actual Linux x64 screenshots show the released App beta 17 connected to
server beta 39 through normal authenticated Iroh membership. The marketplace
loaded 12 official entries and 30 real registry results in one grid. OAuth was
unavailable on this disposable server; the images demonstrate the presentation,
not provider consent or API access. See the
[qualification scope](./connector-status.md#what-the-tests-establish).

:::

Embedding hosts display these integrations in their **MCP marketplace**
alongside custom MCP endpoints. OAuth disclosure identifies the product and
the particular receiving installation. Third-party products may use the shared
protocol; an operator-supplied name does not mean OpenAgent has approved it.

The server exposes the authenticated catalog at `GET /api/marketplace/official`; `GET /api/connectors/catalog` remains compatible. Unavailable entries include their reason; neither response contains credentials.

The CLI uses the same authenticated server and permissions:

```sh
openagent-cli marketplace official
openagent-cli marketplace official gmail --json
openagent-cli marketplace search filesystem
openagent-cli connectors list
openagent-cli connectors connect replio
# Keyless commands use the published beta 43 CLI/server:
openagent-cli connectors connect exa
openagent-cli connectors connect firecrawl
openagent-cli connectors connect parallel-search
openagent-cli connectors connect context7
openagent-cli connectors connect coingecko
openagent-cli connectors reconnect <connection-id>
openagent-cli connectors refresh <connection-id>
openagent-cli connectors sites <connection-id>
openagent-cli connectors select-site <connection-id> <cloud-id>
openagent-cli connectors configure <connection-id> --read-only
openagent-cli connectors configure <connection-id> --disabled
openagent-cli connectors disconnect <connection-id>
```

Select a saved membership with `--network`, `--agent` and `--handle`. Tokens/account passwords use hidden interactive input, rather than command arguments. OAuth opens the browser and polls through the authenticated outgoing connection. The interactive `/mcps` menu also offers the official marketplace.

Keyless connections keep local owner/tenant permissions, enable/disable and
disconnect controls, but store no provider token and need no refresh or provider
revocation. Their quotas apply to anonymous provider access; calls do not switch
to an authenticated or paid plan. The [SDK 0.1.6 six-read receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.6-2026-10-17.json)
qualifies both compiled tools of Parallel, Context7 and CoinGecko through the
normal runner. The [beta 43 product lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b43-2026-10-17.json)
separately passed three normal connections and six authorized workflow reads
across a real restart, followed by tombstones/source removal and cleanup.
Its metrics describe workflow-result bytes, not observed provider HTTP attempts.
Exa/Firecrawl real reads retain their [SDK 0.1.5](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.5-2026-10-17.json)
and [beta 41 lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json)
scope. Search API success does not establish result relevance. GUI-local
controls above made no provider calls and do not extend those receipts.

Each server keeps its own encrypted token copy. Connecting the same Shopify shop to another server requires a fresh verified Shopify consent and explicit authorization of that recipient. Token rotation is serialized per app/shop and synchronized in temporary encrypted messages. A server that missed a message can request a current peer copy; if none is available it needs a new consent.

Disabling a connection prevents tool use without deleting its saved credentials.
Where supported, **Allow changes** additionally controls mutating operations.
Embedding hosts also retain workspace/project scope and explicit agent
grants; saving a connection does not grant every agent access.

**Disconnect from this server** removes that product's local access. Removing/revoking the app in the provider's settings can affect other products using the same app. Reconnection requires consent; existing credentials are never silently reassigned to another OAuth app.

## Privacy and availability

Read the [OpenAgent privacy notice](/privacy) for data handling, retention, configured model providers and privacy requests. Support and privacy contact: [geroale2000@gmail.com](mailto:geroale2000@gmail.com), under the AI Agent commercial name.

`auth.openagent.uno` handles authorization-code exchange and renewals that require the app secret. Access tokens and refresh tokens are transient during those operations and are not stored permanently by OpenAgent's central service. Normal email, file, store and task API contents do not pass through it.

The service durably stores installation identities, authorized Shopify recipient groups, credential generations/fingerprints and a deduplicated queue of minimized, encrypted Shopify privacy/uninstall notifications. Temporary encrypted token messages expire within ten minutes. Privacy actions and exports belong to the receiving product. Standalone beta 39 publishes strict opt-in processing via `connectors.privacy.enabled=true` for a fresh canonical text-history cohort; coverage is computed before startup, not declared in configuration. Historical content, media, Vault/files and unqualified callbacks keep jobs blocked. This does not activate Shopify; provider reviews and real end-to-end acceptance remain separate gates. See the [coverage and release checkpoint](./connector-status.md).

A central outage prevents new common-app consents and secret-dependent renewals. Locally valid tokens and other local/MCP capabilities continue to work. Hosts can retain their own OAuth registrations instead of opting into common apps. Standalone servers can configure `connectors.oauth_providers_file` for Google, ClickUp or Postiz, with registered loopback callbacks and local secret files; Shopify own apps use a separately configured broker to retain shared-store coordination. Google restricted scopes still require applicable verification/security assessment.

## Embedding and releases

The library is [`openagent-tools/packages/connectors`](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.8/packages/connectors), with a local runner and Python/MCP adapter. Versioned platform bundles carry manifests and checksums; product builds pin them. Core integrates through public capability APIs. The [deployment runbook](https://github.com/openagent-uno/openagent-tools/tree/connector-auth-v0.1.6/deploy/connector-auth) describes provider registration and activation gates.

## Connection requirements by service

| Service | Setup details |
| --- | --- |
| 90 provider API profiles | Dedicated authorized API/access token; two read tools per provider; local encrypted storage and provider permission checks; new App22 setup/GUI remains pending |
| OneDrive, SharePoint | Authorized Microsoft OAuth app and account consent, followed by server-verified drive/site selection; common enrollment and real-provider qualification remain pending |
| Exa, Firecrawl, Parallel Search, Context7, CoinGecko | Keyless since server/CLI43 and App20; Linux x64 local controls passed; no account, key, OAuth consent or refresh; anonymous quotas and per-tool qualification limits apply |
| Google Drive, Gmail, Google Analytics | Provider consent through the configured Google app; Google Analytics needs an accessible GA4 property |
| ClickUp | Consent for the existing configured app and the user's permitted workspace access |
| Shopify | Verified store consent and explicit receiving-server authorization; standalone enrollment is currently blocked by its privacy-processing gate |
| Postiz | Configured provider registration, credential rotation and real consent qualification before activation |
| Replio | Dedicated organization-wide `rpl_…` key and organization UUID |
| BillingBear | Project API token and project identifier |
| Pipeboard Ads | API token and provider identifier `meta_ads` or `google_ads` |
| IMAP Email | IMAP/SMTP hosts, username, account/app password, mailbox and sender; implicit TLS or STARTTLS |

The catalog describes supported operations; a provider account still needs the
corresponding provider permissions. Gmail sending, store writes, social
publishing and campaign changes require the receiving product's local write
authorization in addition to the provider grant.

For availability errors, expired consent, broker outages and Shopify peer
recovery, see [troubleshooting](./connector-operations.md#troubleshooting).
