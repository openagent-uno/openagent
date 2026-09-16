# OpenAgent

The standalone OpenAgent product: desktop app, CLI, server and MCP bridge.
The product consumes independently versioned OpenAgent Core and OpenAgent
Tools packages. GlassPalace and other applications consume the same libraries
through their public contracts and own their own deployments.

Start with [the documentation index](docs/README.md). Repository paths and
build entry points are listed by `python3.11 scripts/workspace.py list`.

The v1 migration is in progress. Imported legacy components remain executable
while the package boundaries are cut over; this checkout is not a published
v1 release. Existing updater endpoints remain in place until the complete
transition chain is qualified.
