# Using connectors

::: info Published releases and activation gates
As of 17 October 2026, shared library/runner **0.1.5 is published** with
16 official adapters plus Custom MCP. [Server/CLI beta 42](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.42)
is published with SDK 0.1.5, Core beta 22 and Host Tools B6. The current
released App is beta 19, with six qualified native targets. Its marketplace
GUI qualification passed on Linux x64 with server beta 42: 16 official entries
and 30 registry results share one grid. Local Exa/Firecrawl controls passed
without provider calls; hosted `--no-sandbox` does not qualify sandbox security.
The fresh public beta 42 installer passed
across distinct filesystems. The limited keyless product lifecycle passed on
beta 41; beta 42 preserves that provider implementation unchanged.
Beta 40 pins connector 0.1.4 and B6; older installations retain their own pins
until updated. The released App beta 18/server beta 40 marketplace has been
visually verified on Linux x64 with 14 official entries and registry MCPs in
one grid. Mac and Windows marketplace GUI acceptance remain separate.
Publishing a component does not update an installed product. Common OAuth enrollment is open as a limited public beta for ClickUp, GitHub
and Notion. Released server beta 40 requires the explicit provider configuration
below. Slack has a limited real QA receipt but public distribution remains
disabled; Jira secret custody and consent remain pending. Shopify remains
disabled; Google verification and real provider qualification remain pending.
Postiz is registered, with credential rotation required before activation. See
[release status and remaining gates](./connector-status.md).
:::

OpenAgent provides one shared connector implementation for the standalone server and independent host products that embed it. Your product server stores encrypted credentials and makes normal API calls directly to the provider. Accounts, agent history, files and customer databases remain with that product.

The shared authentication service accepts ClickUp, GitHub and Notion enrollment. On released server beta 40, operators enable these providers with `connectors.official_providers: [clickup, github, notion]` or `OPENAGENT_CONNECTOR_AUTH_PROVIDERS=clickup,github,notion`. Server beta 41 defaults to those three only when neither setting is supplied. An explicit empty list or empty environment value remains an opt-out; listing a provider creates no connection, broker registration or grant. Every OAuth connection still requires local authorization and the provider's consent. See the [configuration precedence](./connector-operations.md#standalone-configuration). Shopify enrollment is currently disabled: the published opt-in privacy processor covers a fresh canonical text-history cohort, with additional storage and real-provider acceptance gates still required. Existing tokens retain their original OAuth registration. The legacy ClickUp callback has been removed by the operator; a new ClickUp consent must use the shared app callback.

## Shared components

The [architecture guide](./shared-components.md) explains which parts are
shared and which stay in the receiving product. Operators can use the
[setup and recovery guide](./connector-operations.md).

## Connector library

The [ChatGPT app coverage guide](./chatgpt-apps.md) records the complete publicly
observed directory and the initial Popular order. Published SDK 0.1.4 adds
GitHub, Notion, Slack and Jira and is adopted by server/CLI beta 40. Library publication and provider activation are separate. The three-provider
OAuth beta is now deployed. See that guide for
operations, limited real QA receipts and remaining gates. SDK 0.1.5 adds Exa
and Firecrawl keyless reads, adopted by published server/CLI beta 42.
Their limited workflow/restart/disconnect lifecycle passed on beta 41; the
[receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json)
retains its exact scope. [App beta 19 is published](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.19);
its [limited Linux x64 marketplace and local keyless controls](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
passed with server beta 42. This made no provider calls and does not establish
Mac/Windows GUI, sandbox security or all-tool acceptance. Installing SDK 0.1.5
alone does not update beta 40 or beta 18.

The table describes published SDK 0.1.5. Exa and Firecrawl require a receiving
product with the keyless connection contract; the released beta 40/beta 18
pair retains its 14-entry catalog. Provider grants, reviews and receiving-host
rollout remain separate from library availability.

| Connector | Authentication | Shared implementation |
| --- | --- | --- |
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
| Exa | Keyless, no account or API key | Public search/fetch; 2 read tools; fetch/workflow/restart/disconnect passed on beta 41, not all-tool or native App provider-call acceptance |
| Firecrawl | Keyless, no account or API key | Public search/Markdown scrape; 2 read tools; scrape/workflow/restart/disconnect passed on beta 41, not all-tool or native App provider-call acceptance |

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
   With published server beta 42 and App beta 19, Exa and Firecrawl use the same
   card's **Install → Connect** flow without a token prompt or OAuth page.
5. Open **Manage** on the connected card to enable/disable tools, authorize
   changes where the integration supports them, reconnect or disconnect locally.

Read/write controls govern product tool admission. Provider OAuth scopes may
be broader; a local read-only choice does not rewrite the provider's grant.
A token connection being saved as Connected does not prove a successful
provider API call; verify access with an appropriate authorized operation.

![Released App beta 19 with server beta 42: 16 official connectors share the same marketplace grid as registry MCPs](/connectors/app19-server42-marketplace-top.png)

![App beta 19 with server beta 42: official provider logos and registry MCPs use the same cards](/connectors/app19-server42-marketplace-scroll.png)

![Exa connected through the normal App beta 19 marketplace without a credential form](/connectors/app19-server42-exa-connected.png)

![Firecrawl connected through the normal App beta 19 marketplace without OAuth controls](/connectors/app19-server42-firecrawl-connected.png)

These actual Linux x64 screenshots show public App beta 19 connected to public
server beta 42 through ordinary Join/SRP, device certification and native Iroh.
The marketplace loaded 16 official entries and 30 real registry results in one
grid without an official tab, label or divider; six local provider icons were
verified. Exa and Firecrawl each passed Connect, disable/re-enable and local
disconnect without a credential form, OAuth page, provider call or model.
The worker used Electron `--no-sandbox`; this does not establish sandbox
security, Mac/Windows GUI acceptance or provider tool parity. See the
[visual receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
for exact versions, hashes, cleanup and preserved harness failures. The four
real provider reads across restart remain attributed to the separate beta 41
receipt.

The [App beta 18/server beta 40 trial](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app18-server40-marketplace-2026-10-16.json)
remains historical evidence with 14 official entries. Its
[top screenshot](/connectors/app18-server40-marketplace-top.png) and
[scrolled screenshot](/connectors/app18-server40-marketplace-scroll.png)
are retained unchanged.

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
# Keyless commands use the published beta 42 CLI/server:
openagent-cli connectors connect exa
openagent-cli connectors connect firecrawl
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
to an authenticated or paid plan. The [four real runner reads](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-sdk-0.1.5-2026-10-17.json)
qualify the limited SDK operations. Separately, the
[beta 41 product lifecycle](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/keyless-product-1.1.0b41-2026-10-17.json)
passed two normal connections, four authorized public reads across an actual
restart, and local disconnect/tombstone/source removal. Beta 42 leaves that
provider code unchanged and separately passed its
[fresh cross-filesystem public installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json).
Neither receipt establishes native App provider-call acceptance or all tools.
The separate Linux x64 GUI trial above qualifies marketplace presentation and
local controls only. Search API success alone does not prove result relevance.

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

The library is [`openagent-tools/packages/connectors`](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.5/packages/connectors), with a local runner and Python/MCP adapter. Versioned platform bundles carry manifests and checksums; product builds pin them. Core integrates through public capability APIs. The [deployment runbook](https://github.com/openagent-uno/openagent-tools/tree/connector-auth-v0.1.6/deploy/connector-auth) describes provider registration and activation gates.

## Connection requirements by service

| Service | Setup details |
| --- | --- |
| Exa, Firecrawl | Keyless connection on server/CLI beta 42; limited lifecycle proved on beta 41; App beta 19 published; Linux x64 GUI/local controls passed; no account, key, OAuth consent or provider refresh; anonymous quotas apply |
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
