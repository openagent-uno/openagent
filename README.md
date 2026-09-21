# OpenAgent

The standalone OpenAgent product: desktop app, CLI, server and MCP bridge.
The product consumes independently versioned OpenAgent Core and OpenAgent
Tools packages. GlassPalace and other applications consume the same libraries
through their public contracts and own their own deployments.

Start with [the documentation index](docs/README.md). Repository paths and
build entry points are listed by `python3.11 scripts/workspace.py list`.
The public guide and verified downloads are at
[openagent.uno](https://openagent.uno/); new coordinated product releases are
published only from this repository.

The `v1.1.0-beta.5` release candidate uses the modular runtime and public
package boundaries throughout. Imported legacy components remain available for
the updater transition, while new builds consume pinned Core and Tools wheels.
Existing updater endpoints stay in place until every supported platform has
completed its signed transition chain.
