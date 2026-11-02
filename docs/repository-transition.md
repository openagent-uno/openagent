# Repository and updater transition

## Canonical repositories

New development and releases use exactly three repositories:

| Repository | Status |
| --- | --- |
| [`openagent`](https://github.com/openagent-uno/openagent) | Canonical standalone product, documentation source and coordinated releases |
| [`openagent-core`](https://github.com/openagent-uno/openagent-core) | Canonical runtime, contracts, SDK, storage and modules |
| [`openagent-tools`](https://github.com/openagent-uno/openagent-tools) | Canonical autonomous and device tools |

## Distribution consolidation in progress

On 2 November 2026 the owner explicitly chose to retire the old updater URLs.
Old installations must be upgraded manually to a build with the canonical
updater; automatic bridging from the retired repositories is intentionally not
promised. Reinstalling an older build does not change its embedded feed.

The owner also explicitly authorized discarding historical releases, including
copies already imported into this repository. Bulk preservation was cancelled.
Keep only distributions needed by active clients and their pinned dependencies;
retire old repositories after the new manual installation path is verified.
Git/LFS source backups and signing configuration are preserved separately.
See [the migration procedure and current gates](release-consolidation.md).

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

The MCP server starter is now maintained in
[`openagent-tools/examples/mcp-server`](https://github.com/openagent-uno/openagent-tools/tree/main/examples/mcp-server).
Its original Git ancestry and refs are preserved there; the original release
metadata is mirrored as `mcp-template-v0.1.0`. Retirement of the wrapper is
recorded only after independent backup and remote verification.

## Historical qualification baseline

The recorded transition baseline was
[`v1.1.0-beta.34`](https://github.com/openagent-uno/openagent/releases/tag/v1.1.0-beta.34),
with Core `v1.1.0-beta.19`, Tools `v1.0.0-beta.4`, and desktop App
`v1.1.0-beta.15`. Its manifest remains `development-unqualified`: the release
includes a qualified Apple Silicon desktop artifact and Python wheels but does
not claim a complete cross-platform updater chain.
