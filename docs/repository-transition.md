# Repository and updater transition

## Canonical repositories

The GitHub organization retains exactly three repositories:

| Repository | Responsibility |
| --- | --- |
| [`openagent`](https://github.com/openagent-uno/openagent) | Standalone App/CLI/server, shared product composition, documentation and coordinated distribution |
| [`openagent-core`](https://github.com/openagent-uno/openagent-core) | Agnostic kernel, contracts, SDK, storage and modules |
| [`openagent-tools`](https://github.com/openagent-uno/openagent-tools) | Independent tools, device/browser control, connector SDK and MCP server starter |

The public website and documentation are built from `docs/site` in this
repository by `.github/workflows/docs-pages.yml`, served through GitHub Pages at
`openagent.uno`. The MCP bridge remains in `apps/mcp-bridge`. The starter is
maintained at `openagent-tools/examples/mcp-server`, including original source
ancestry and namespaced reference aliases; its useful example release is 0.2.0.

## Completed retirement — 2 November 2026

The owner explicitly authorized retiring `openagent-app`, `openagent-cli`,
`openagent-server`, `openagent-host-tools`, `openagent-mcp-template`,
`openagent-mcp` and `openagent-docs`. Source Git refs/bundles, LFS objects and
useful metadata were verified in private backups. Unpublished source inputs and
signing settings were preserved separately. Historical release/CI payloads were
explicitly discarded; initial bulk copies were cancelled and removed.
Historical source URLs in import manifests and dated receipts are provenance,
not live distribution destinations. The old docs github.io URL is retired.

The retained native compatibility components `host-tools-v0.1.2` and
`host-tools-v0.1.3` serve active versioned pins. Their six-platform archives,
Python wheels, detached hashes and signatures retain their original bytes.
Only the distribution locator in `release-index.json` and aggregate checksum
metadata change. Native B7 remains unchanged for its current App consumers.

## Manual upgrade

Old updater URLs intentionally stop working. Install a build with the canonical
updater: **App beta24** or **server/CLI 1.1.8**. Downloading an older installer
from a different location does not rewrite its embedded updater. Replace an
existing App without deleting profiles or agent directories; rerun the pinned
server/CLI installer for the selected installation root. Application IDs,
protocol, identity paths, trust and consent stay unchanged. Manual beta selection
opts into that channel; no automatic stable-to-beta or downgrade is introduced.

The App reads the canonical `app-update-feed`; metadata points to immutable
versioned App assets. The server paginates canonical releases, normalizes
GitHub's numeric repository links back to its own authority and selects only an
exact native server archive. Unrelated App/CLI/tool/wheel releases cannot hide
an applicable update.

See [the procedure](release-consolidation.md), [current downloads](site/downloads.md)
and [the dated verification receipt](qualification/release-consolidation-2026-11-02.json).
