# Official connectors

OpenAgent provides one shared connector implementation for the standalone server, GlassPalace, ICS and other products that embed it. Your product server stores encrypted credentials and makes normal API calls directly to the provider. Accounts, agent history, files and customer databases remain with that product.

The shared authentication release is being qualified. New common-app enrollment becomes available only after provider approval and end-to-end acceptance. Existing GlassPalace/ICS own-app connections continue to use their original registration until you explicitly authorize a new one.

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

In the standalone client, open **MCPs → Official**, select the connector, and authorize in the browser or enter the required account credentials. OAuth disclosure identifies the product and the particular receiving installation. Third-party products may use the shared protocol; an operator-supplied name does not mean OpenAgent has approved that product.

Each server keeps its own encrypted token copy. Connecting the same Shopify shop to another server requires a fresh verified Shopify consent and explicit authorization of that recipient. Token rotation is serialized per app/shop and synchronized in temporary encrypted messages. A server that missed a message can request a current peer copy; if none is available it needs a new consent.

**Disconnect from this server** removes that product's local access. Removing/revoking the app in the provider's settings can affect other products using the same app. Reconnection requires consent; existing credentials are never silently reassigned to another OAuth app.

## Privacy and availability

`auth.openagent.uno` handles authorization-code exchange and renewals that require the app secret. Access tokens and refresh tokens are transient during those operations and are not stored permanently by OpenAgent's central service. Normal email, file, store and task API contents do not pass through it.

The service durably stores installation identities, authorized Shopify recipient groups, credential generations/fingerprints and a deduplicated queue of minimized, encrypted Shopify privacy/uninstall notifications. Temporary encrypted token messages expire within ten minutes. Privacy actions and exports belong to the receiving product. The standalone currently durably receives notifications and disconnects revoked grants; export/redaction of stored agent content is not yet implemented and blocks Shopify activation there. Provider reviews and real end-to-end acceptance remain separate activation gates.

A central outage prevents new common-app consents and secret-dependent renewals. Locally valid tokens and other local/MCP capabilities continue to work. Hosts can retain their own OAuth registrations instead of opting into common apps. Standalone servers can configure `connectors.oauth_providers_file` for Google, ClickUp or Postiz, with registered loopback callbacks and local secret files; Shopify own apps use a separately configured broker to retain shared-store coordination. Google restricted scopes still require applicable verification/security assessment.

## Embedding and releases

The library is [`openagent-tools/packages/connectors`](https://github.com/openagent-uno/openagent-tools/tree/connectors-v0.1.0/packages/connectors), with a local runner and Python/MCP adapter. Versioned platform bundles carry manifests and checksums; product builds pin them. Core integrates through public capability APIs. The [deployment runbook](https://github.com/openagent-uno/openagent-tools/tree/codex/shared-official-connectors/deploy/connector-auth) describes provider registration and activation gates.
