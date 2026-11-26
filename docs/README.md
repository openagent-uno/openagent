# OpenAgent documentation

- [App beta 76 and conversation recovery](releases/app-v1.1.0-beta.76.md).
- [Server beta 116 and delegated channel replies](releases/v1.1.9-beta.116.md).
- [Server beta 115 and session and device reliability](releases/v1.1.9-beta.115.md).
- [App beta 75 and session tool-card alignment](releases/app-v1.1.0-beta.75.md).
- [App beta 74 and desktop page reloads](releases/app-v1.1.0-beta.74.md).
- [Server beta 108 and durable manual automation](releases/v1.1.9-beta.108.md).
- [Server beta 107 and standalone recovery](releases/v1.1.9-beta.107.md).
- [Server beta 106 and durable project tasks](releases/v1.1.9-beta.106.md).
- [App beta 73 and project workspaces](releases/app-v1.1.0-beta.73.md).
- [Product beta99: automatic model recovery](releases/v1.1.9-beta.99.md).
- [App beta72: visible errors after history reconciliation](releases/app-v1.1.0-beta.72.md).
- [Server beta89: bounded fresh history authorization](releases/v1.1.9-beta.89.md).
- [App beta69: settings refresh and large graph simulation](releases/app-beta.69.md).
- [Server beta88: nullable runtime history recovery](releases/v1.1.9-beta.88.md).
- [App beta68: legacy timestamp display](releases/app-beta.68.md).
- [Server beta87: typed account policy and shared custody accounting](releases/v1.1.9-beta.87.md).

- [Server beta86: shared subscription custody and public host CLI composition](releases/v1.1.9-beta.86.md).

- [Server beta85: deferred linked-tool bodies and explicit account routing](releases/v1.1.9-beta.85.md).

- [App beta 64: deferred tool inspection and declared account policy](releases/app-beta.64.md).

- [Server beta 83 and App beta 61 qualification](releases/v1.1.9-beta.83.md).
- [Provider accounts, typed models and settings](site/guide/models.md).
- [Measured loading changes and remaining performance limits](performance-2026-11-17.md).

- [Server beta84: negotiated JSON transfer](releases/v1.1.9-beta.84.md).

## Architecture and use

- [Server beta102 and channel attachment delivery](releases/v1.1.9-beta.102.md)
- [Server beta101 and Core beta152](releases/v1.1.9-beta.101.md)
- [Product beta100: inherited streaming responder identity](releases/v1.1.9-beta.100.md).

- [Agnostic architecture: mandatory in every OpenAgent repository](AGNOSTICISM.md)
- [Component responsibilities, organization and communication](COMPONENTS.md)
- [Using the kernel, clients, tools and runners](USAGE.md)


Start with [project context and ownership](PROJECT.md) and the [vision](site/vision.md).
Agent features and fixes belong in OpenAgent Core/Tools/product, then flow through
public versioned capabilities to consumers; product-local patches are prohibited.

## Reading paths

- [Automatic latest downloads](qualification/latest-downloads-2026-11-13.json):
  independent App/server/CLI discovery, all published platform packages and live site qualification.

- [Telegram confirmed reset recovery](qualification/telegram-reset-2026-11-13.json)
  (Python product beta35, Core beta83, Channel Bridges beta24).

- [Unreleased live transcript recovery](site/guide/client-capabilities.md#recovering-the-live-transcript-unreleased-source)
  ([source and Mac Electron qualification](qualification/shared-observer-recovery-2026-11-12.json)).

- [Python beta18: explicit legacy private conversation continuity](releases/v1.1.9-beta.18.md)
  ([public qualification](qualification/python-product-b18-2026-11-07.json)).

- [Python beta17: complete Core53/Sessions adoption and scoped history recovery](releases/v1.1.9-beta.17.md)
  ([public qualification](qualification/python-product-b17-2026-11-07.json)).

- [Editable channel turns and confirmed outgoing history](site/guide/channels.md#editable-live-turns-beta23) ([component qualification](qualification/channel-editable-turns-2026-11-12.json), [live Telegram acceptance](qualification/telegram-turns-public-2026-11-12.json)).
- [Unreleased mapped-channel history recovery](site/guide/embedded-channels.md#recovering-mapped-conversation-history-unreleased-source-fix)
  ([source qualification](qualification/channel-history-recovery-2026-11-07.json)).

- [Python beta12: revision integrity and bounded summaries](releases/v1.1.9-beta.12.md).

- Architecture: [v1 boundaries](architecture-v1.md), [modules](modules-v1.1.md), [application composition](site/guide/application-composition.md).
- [Skills in the app and agent tools](USAGE.md#skills).
- Public guides: [site](site/index.md), [client capabilities](site/guide/client-capabilities.md), [channels](site/guide/channels.md), [MCP Apps](site/guide/mcp-apps.md).
- Connectors: [operations](site/guide/connector-operations.md), [status and remaining gates](site/guide/connector-status.md), [privacy](site/privacy.md).
- Distribution: [build/release](build-and-release.md), [runtime qualification](runtime-and-verification.md), [repository/updater transition](repository-transition.md).
- Receipts and releases: `qualification/`, `releases/`, and the [previous release index](INDEX-HISTORY-2026-11-02.md).

## Maintenance

Keep this index short. Update the owning guide and a dated receipt for new evidence.
Local tests, published packages, signed GUI acceptance and production are separate
verification levels. Retired distribution repositories are preserved as private source backups, not feature repositories.
See [the memory audit and upstream rule](PROJECT.md) for source precedence and private-data handling.
