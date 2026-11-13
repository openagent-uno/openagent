# Download OpenAgent

Download the latest published App, server or CLI below. Each section discovers
its own newest version from the canonical OpenAgent releases, including betas.
New releases appear here without rebuilding this website. Returning to the page
refreshes metadata older than one minute. Beta builds are labeled.

## Desktop app

<ReleaseDownloads target="desktop" />

Choose the package for **macOS, Windows or Linux** and your CPU architecture.
macOS offers Apple Silicon and Intel packages; Windows and Linux offer ARM64
and x64 packages when published. Every file belongs to the displayed App release.
A platform not published for that release is identified explicitly.

For an existing installation, replace the App at the same location and keep its
profile and agent directories. Consult that build's release notes for signing,
notarization, update-channel behavior and qualification.

## Standalone server

<ReleaseDownloads target="server" />

The server is a **Python 3.11+ wheel for all supported platforms**, rather than a
separate desktop installer. Use the matching component versions and dependency
set recorded in its release manifest and notes. See [Getting Started](./guide/getting-started)
for deployment requirements.

## CLI

<ReleaseDownloads target="cli" />

The CLI is a **Python 3.11+ wheel for all supported platforms**. It connects to a
running OpenAgent server. If server and CLI share an installation environment,
update their exact-version dependencies together.

## Libraries and release evidence

[OpenAgent Core](https://github.com/openagent-uno/openagent-core/releases) and
[OpenAgent Tools](https://github.com/openagent-uno/openagent-tools/releases) are
independently versioned. Their exact versions, native capabilities and SHA-256
digests belong to the selected product release's notes and manifests.

The App, server and CLI can have different latest versions. Source publication,
package signing and platform/provider acceptance are separate qualification levels;
consult each release's evidence. Historical receipts document their original
versions and do not determine the download buttons above.

If GitHub is unavailable or rate limits release discovery, the page offers a retry
and a link to [all canonical releases](https://github.com/openagent-uno/openagent/releases).
It does not substitute an old pinned build.

Existing installations using retired updater URLs may need a manual replacement
with a canonical-updater App. Preserve identities, profiles and agent data; see
[the migration procedure](https://github.com/openagent-uno/openagent/blob/main/docs/release-consolidation.md).
