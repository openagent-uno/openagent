# Repository and updater transition

## Canonical repositories

New development and releases use exactly three repositories:

| Repository | Status |
| --- | --- |
| [`openagent`](https://github.com/openagent-uno/openagent) | Canonical standalone product, documentation source and coordinated releases |
| [`openagent-core`](https://github.com/openagent-uno/openagent-core) | Canonical runtime, contracts, SDK, storage and modules |
| [`openagent-tools`](https://github.com/openagent-uno/openagent-tools) | Canonical autonomous and device tools |

## Historical repositories

`openagent-app`, `openagent-cli`, `openagent-server`, `openagent-mcp`,
`openagent-host-tools` and `openagent-docs` preserve imported history, tags,
release assets and update endpoints. They receive no new feature development.

The owner accepted the public site and canonical download surface on
21 September 2026 and authorized archival of these repositories. They are now
archived, not deleted. Archiving keeps their source, immutable tags, release
downloads and updater endpoints available while preventing new development in
the retired repositories. The public site deploys from `openagent/docs/site`;
`openagent-docs` retains only its historical deployment record and transition
mirror.

The current beta remains `development-unqualified`. Archival preserves the
historical endpoints needed to test installed 0.x discovery, transition to the
canonical distribution, a subsequent canonical update and rollback; it does
not claim that the full cross-platform updater chain has already qualified.

`openagent-mcp-template` is a maintained starter template rather than an
imported product component. It remains active unless it is replaced by a new
template owned by the canonical product repository.

## Current beta

The coordinated product release is
[`v1.1.0-beta.2`](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.2),
with Core `v1.1.0-beta.1` and Tools `v1.0.0-beta.1`. Its manifest is
`development-unqualified`: it includes a qualified Apple Silicon desktop
artifact and Python wheels but does not claim a complete cross-platform updater
chain.
