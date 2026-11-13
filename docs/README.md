# OpenAgent documentation

## Architecture and use

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
