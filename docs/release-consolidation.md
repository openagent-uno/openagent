# Historical release consolidation and manual upgrade

Decision: 2 November 2026. The owner accepts retiring old updater URLs and
**explicitly authorized deleting historical releases, including their mirrored
copies**. The earlier full-release preservation plan is superseded. Only releases
needed by current installers, active clients, versioned dependencies and current
qualification remain. Keep source Git/LFS backups and signing configuration;
do not silently treat a still-pinned dependency as disposable history.

Only `openagent`, `openagent-core` and `openagent-tools` remain canonical. Old
repositories are removed after their useful distributions have a verified
canonical replacement and the new manual installation path is qualified.

## Distribution and feeds

- Product wheels, installers and historical distribution mirrors live in
  `openagent-uno/openagent`. Historical tags gain `app-`, `cli-`, `server-` or
  `host-tools-` prefixes to avoid tag/asset collisions. Their original binaries
  are not rebuilt, and source drafts remain drafts.
- The App uses a generic feed at
  `https://github.com/openagent-uno/openagent/releases/download/app-update-feed/`.
  Channel metadata points to immutable assets under versioned canonical tags.
  Stable/beta selection and the prohibition on automatic downgrade are retained.
  Feed publication must verify every referenced payload and checksum first.
- The server reads paginated canonical releases and selects only a release with
  the exact server archive for its platform. App, CLI, host-tools and wheel-only
  releases cannot hide a usable server update. `server-` historical tags are
  parsed explicitly; incompatible artifacts are never offered as server updates.
- The standalone MCP server starter belongs to
  `openagent-tools/examples/mcp-server`, including the original Git ancestry and
  namespaced reference tags. It is not a fourth feature repository.

## Manual upgrade contract

Install a new build containing the canonical updater. An older installer can
still embed the retired feed even if downloaded from the canonical repository.
Do not uninstall first or delete a profile. Replace the App in its existing
location, or rerun the canonical server/CLI installer for the same installation.
Preserve `ai.openagent.desktop`, the `openagent` URL scheme, identity keys,
agent directories, profiles, trust and device-consent files. Windows installers
retain application data when removed. No installed user profile is modified by
the qualification workflow: packaged smoke tests use isolated profiles.

App beta 24 and product 1.1.7 are the migration build candidates. The Python
host-tools facade is versioned as B8 to depend on Device Tools B10 without
rewriting the published B7 wheel. App native bundles remain the exact signed B7
assets in its lock; this migration does not claim a rebuilt native tool bundle. They are usable
manual upgrade destinations only after publication and artifact verification;
the source version bump alone does not establish availability. Do not label the
old App beta 22 mirror as a new-updater build.

## Retirement gates and explicit historical deletion

The old inventory contains 334 releases and 3,188 assets (293,747,689,240
bytes), including nine App drafts. The owner subsequently chose to discard this
release history. Bulk copies were cancelled, the temporary migration credential
was removed and incomplete/imported historical releases are eligible for
removal. Historical CI artifacts are likewise not required distributions.
Do not describe the discarded bytes as backed up or migrated.

Before deletion, verify the new App installers, their embedded canonical feed,
server/CLI wheel dependency resolution, and every retained dependency URL.
Preserve source Git refs/LFS and signing settings separately. Private metadata
and source backups must remain private; never publish old draft build inputs.
`scripts/migrate-release-assets.py` remains a bounded, checksum-verifying utility
for deliberately selected artifacts. It does not authorize bulk restoration or
publication of historical drafts.

Existing signing configuration was transferred directly through sealed GitHub
secret updates, without logging or local plaintext storage. The independent
[verification run](https://github.com/openagent-uno/openagent/actions/runs/41428714304)
confirmed all 26 configured value copies and the common macOS signing team.
The original App/CLI/server configurations are retained separately as secrets;
only names and aggregate evidence belong in documentation. Remove the temporary
migration authorization and fingerprint secrets after their jobs finish.

Tests and signing checks establish specific artifact behavior. They do not
claim provider acceptance, installation on a user's device or a production
deployment. Publish a final dated receipt with retained/deleted release counts,
new build digests and verification evidence before recording retirement complete.
