# OpenAgent documentation

## Architecture and use

- [Agnostic architecture: mandatory in every OpenAgent repository](AGNOSTICISM.md)
- [Component responsibilities, organization and communication](COMPONENTS.md)
- [Using the kernel, clients, tools and runners](USAGE.md)


Start with [project context and ownership](PROJECT.md) and the [vision](site/vision.md).
Agent features and fixes belong in OpenAgent Core/Tools/product, then flow through
public versioned capabilities to consumers; product-local patches are prohibited.

## Reading paths

- [Python beta17 candidate: complete Core53/Sessions adoption and scoped history recovery](releases/v1.1.9-beta.17.md).

- [Unreleased mapped-channel history recovery](site/guide/embedded-channels.md#recovering-mapped-conversation-history-unreleased-source-fix)
  ([source qualification](qualification/channel-history-recovery-2026-11-07.json)).

- [Python beta12: revision integrity and bounded summaries](releases/v1.1.9-beta.12.md).

- Architecture: [v1 boundaries](architecture-v1.md), [modules](modules-v1.1.md), [application composition](site/guide/application-composition.md).
- Public guides: [site](site/index.md), [client capabilities](site/guide/client-capabilities.md), [channels](site/guide/channels.md), [MCP Apps](site/guide/mcp-apps.md).
- Connectors: [operations](site/guide/connector-operations.md), [status and remaining gates](site/guide/connector-status.md), [privacy](site/privacy.md).
- Distribution: [build/release](build-and-release.md), [runtime qualification](runtime-and-verification.md), [repository/updater transition](repository-transition.md).
- Receipts and releases: `qualification/`, `releases/`, and the [previous release index](INDEX-HISTORY-2026-11-02.md).

## Maintenance

Keep this index short. Update the owning guide and a dated receipt for new evidence.
Local tests, published packages, signed GUI acceptance and production are separate
verification levels. Retired distribution repositories are preserved as private source backups, not feature repositories.
See [the memory audit and upstream rule](PROJECT.md) for source precedence and private-data handling.
