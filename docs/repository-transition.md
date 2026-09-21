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

They remain unarchived until a human verifies:

1. the public site and all canonical download links;
2. installed 0.x client discovery of the signed transition release;
3. transition to the canonical product distribution;
4. one subsequent update from the canonical repository;
5. rollback and historical asset availability.

After those checks the repositories are archived, not deleted. Archiving keeps
immutable tags, release downloads and source links available. The public site
already deploys from `openagent/docs/site`; `openagent-docs` retains only its
historical deployment record and transition mirror.

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
