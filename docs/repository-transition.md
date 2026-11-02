# Repository and updater transition

## Canonical repositories

New development and releases use exactly three repositories:

| Repository | Status |
| --- | --- |
| [`openagent`](https://github.com/openagent-uno/openagent) | Canonical standalone product, documentation source and coordinated releases |
| [`openagent-core`](https://github.com/openagent-uno/openagent-core) | Canonical runtime, contracts, SDK, storage and modules |
| [`openagent-tools`](https://github.com/openagent-uno/openagent-tools) | Canonical autonomous and device tools |

## Retained distribution repositories

`openagent-app`, `openagent-cli`, `openagent-server` and `openagent-host-tools`
retain historical releases, immutable downloads and update endpoints. They are
not new feature repositories. The App publish configuration and server updater
still name their historical repositories; an unused source tree is not evidence
that its release host can be deleted. Preserve those repositories until an
explicitly qualified distribution/update migration removes the dependency.

The public site is built from `docs/site` in this repository by
`.github/workflows/docs-pages.yml` and deployed to GitHub Pages with the custom
domain `openagent.uno`.

## Removed empty wrappers

On 2 November 2026, the owner explicitly approved deleting the GitHub
repositories `openagent-mcp` and `openagent-docs`. Their final Git refs were
backed up and verified before deletion. Neither repository held release assets.
API readback confirmed both repositories absent and the canonical site's Pages
configuration unchanged. The old `openagent-docs` github.io site is retired.

The MCP bridge distribution/command still exists in `apps/mcp-bridge`; deleting
the old repository does not remove that component. Documentation remains in
`docs/site`. Original import manifests and historical receipts retain their
source URLs as provenance, not live build or release destinations.

`openagent-mcp-template` remains a maintained independent starter, with no
current product build dependency found. It can be consolidated into a canonical
repository in a separate change; it is not presently classified as an unused
wrapper. See [the removal receipt](qualification/repository-removals-2026-11-02.json).

## Historical qualification baseline

The recorded transition baseline was
[`v1.1.0-beta.34`](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.34),
with Core `v1.1.0-beta.19`, Tools `v1.0.0-beta.4`, and desktop App
`v1.1.0-beta.15`. Its manifest remains `development-unqualified`: the release
includes a qualified Apple Silicon desktop artifact and Python wheels but does
not claim a complete cross-platform updater chain.
