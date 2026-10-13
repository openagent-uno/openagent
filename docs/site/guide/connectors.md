# Using connectors

::: info Published releases and activation gates
App beta 16, server/CLI beta 38 and shared library/runner 0.1.2 are published.
Auth-only 0.1.4 is separately deployed. Common OAuth enrollment remains closed
to the public; ClickUp qualification is limited to allowlisted QA servers.
Shopify remains disabled and Google verification/Postiz registration are pending. See
[release status and remaining gates](./connector-status.md).
:::

OpenAgent provides one shared connector implementation for the standalone server, GlassPalace, ICS and other products that embed it. Your product server stores encrypted credentials and makes normal API calls directly to the provider. Accounts, agent history, files and customer databases remain with that product.

The shared authentication release is being qualified. New common-app enrollment becomes available only after provider approval and end-to-end acceptance, and requires the receiving server to opt in explicitly. Shopify enrollment is currently disabled in the standalone while its privacy-content processor is completed. Existing tokens retain their original OAuth registration. The legacy ClickUp callback has been removed by the operator; a new ClickUp consent must use the shared app callback once enabled.

## Shared components

The [architecture guide](./shared-components.md) explains which parts are
shared and which stay in the receiving product. Operators can use the
[setup and recovery guide](./connector-operations.md).

## Connector library

| Connector | Authentication | Shared implementation |
| --- | --- | --- |
| Shopify | OAuth | Products, orders, inventory and permitted store operations |
| Gmail | OAuth | Messages, threads, attachments, drafts and sending |
| Google Drive | OAuth | Search, files, folders and permitted file operations |
| Google Analytics | OAuth | Read-only GA4 reports and metadata |
| ClickUp | OAuth | Tasks, workspaces, Docs, Goals and time tracking |
| Postiz | OAuth | Social integrations, analytics, drafts and publishing; app registration still pending |
| Pipeboard Ads | API token | Meta/Google Ads reports and permitted campaign pause |
| Replio | Organization API token | Apps, conversations and support statistics |
| BillingBear | Project API token | Revenue and customer billing information |
| IMAP Email | Local account/app passwords | Read messages and send through SMTP over TLS |
| GitHub, Slack import | — | Catalog placeholders, unavailable |

Custom MCP servers remain available alongside official connectors. Embedding products retain their own controls over who may install connectors, which agents may use them, and whether they may make changes.

## Connect and disconnect

In App beta 16 connected to server beta 38, or a receiving product with the
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
5. Open **Manage** on the connected card to enable/disable tools, authorize
   changes where the integration supports them, reconnect or disconnect locally.

Read/write controls govern product tool admission. Provider OAuth scopes may
be broader; a local read-only choice does not rewrite the provider's grant.
A token connection being saved as Connected does not prove a successful
provider API call; verify access with an appropriate authorized operation.

![Candidate App: provider integration and registry MCPs share one grid](/connectors/marketplace-preview.png)

This screenshot is from the actual development App and an authenticated
disposable server. Gmail OAuth was deliberately unavailable on that server;
the image demonstrates layout/search, not a completed provider consent.
GlassPalace and ICS display these integrations in their **MCP marketplace**
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
openagent-cli connectors reconnect <connection-id>
openagent-cli connectors configure <connection-id> --read-only
openagent-cli connectors configure <connection-id> --disabled
openagent-cli connectors disconnect <connection-id>
```

Select a saved membership with `--network`, `--agent` and `--handle`. Tokens/account passwords use hidden interactive input, rather than command arguments. OAuth opens the browser and polls through the authenticated outgoing connection. The interactive `/mcps` menu also offers the official marketplace.

Each server keeps its own encrypted token copy. Connecting the same Shopify shop to another server requires a fresh verified Shopify consent and explicit authorization of that recipient. Token rotation is serialized per app/shop and synchronized in temporary encrypted messages. A server that missed a message can request a current peer copy; if none is available it needs a new consent.

Disabling a connection prevents tool use without deleting its saved credentials.
Where supported, **Allow changes** additionally controls mutating operations.
GlassPalace and ICS also retain workspace/project scope and explicit agent
grants; saving a connection does not grant every agent access.

**Disconnect from this server** removes that product's local access. Removing/revoking the app in the provider's settings can affect other products using the same app. Reconnection requires consent; existing credentials are never silently reassigned to another OAuth app.

## Privacy and availability

Read the [OpenAgent privacy notice](/privacy) for data handling, retention, configured model providers and privacy requests. Support and privacy contact: [geroale2000@gmail.com](mailto:geroale2000@gmail.com), under the AI Agent commercial name.

`auth.openagent.uno` handles authorization-code exchange and renewals that require the app secret. Access tokens and refresh tokens are transient during those operations and are not stored permanently by OpenAgent's central service. Normal email, file, store and task API contents do not pass through it.

The service durably stores installation identities, authorized Shopify recipient groups, credential generations/fingerprints and a deduplicated queue of minimized, encrypted Shopify privacy/uninstall notifications. Temporary encrypted token messages expire within ten minutes. Privacy actions and exports belong to the receiving product. The standalone currently durably receives notifications and disconnects revoked grants; export/redaction of stored agent content is not yet implemented and blocks Shopify activation there. Provider reviews and real end-to-end acceptance remain separate activation gates.

A central outage prevents new common-app consents and secret-dependent renewals. Locally valid tokens and other local/MCP capabilities continue to work. Hosts can retain their own OAuth registrations instead of opting into common apps. Standalone servers can configure `connectors.oauth_providers_file` for Google, ClickUp or Postiz, with registered loopback callbacks and local secret files; Shopify own apps use a separately configured broker to retain shared-store coordination. Google restricted scopes still require applicable verification/security assessment.

## Embedding and releases

The library is [`openagent-tools/packages/connectors`](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.2/packages/connectors), with a local runner and Python/MCP adapter. Versioned platform bundles carry manifests and checksums; product builds pin them. Core integrates through public capability APIs. The [deployment runbook](https://github.com/openagent-uno/openagent-tools/tree/connector-auth-v0.1.4/deploy/connector-auth) describes provider registration and activation gates.

## Connection requirements by service

| Service | Setup details |
| --- | --- |
| Google Drive, Gmail, Google Analytics | Provider consent through the configured Google app; Google Analytics needs an accessible GA4 property |
| ClickUp | Consent for the existing configured app and the user's permitted workspace access |
| Shopify | Verified store consent and explicit receiving-server authorization; standalone enrollment is currently blocked by its privacy-processing gate |
| Postiz | Reviewed provider app registration and consent; the common registration is pending |
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
