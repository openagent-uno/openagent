# Historical release consolidation and manual upgrade

Decision: 2 November 2026. The owner accepts retiring old updater endpoints.
Only `openagent`, `openagent-core` and `openagent-tools` remain canonical.
Historical distribution repositories must not be deleted while preservation or
the replacement manual installation path remains incomplete.

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

App beta 24 and product 1.1.7 are the migration build candidates. They are usable
manual upgrade destinations only after publication and artifact verification;
the source version bump alone does not establish availability. Do not label the
old App beta 22 mirror as a new-updater build.

## Preservation gates

The source inventory contains 334 releases and 3,188 assets (293,747,689,240
bytes) across the four old distribution repositories, including nine private
App drafts. `scripts/migrate-release-assets.py` copies through a bounded cache,
checks source and destination SHA-256 and size, rejects collisions, resumes
without overwriting and keeps incomplete imports draft. The bulk workflow emits
aggregate counts only; private release details never become public artifacts.
An independent fresh API comparison is required before source deletion.

Preserve complete Git refs/bundles, LFS objects, release metadata, issues/PRs and
available repository/Actions metadata in a private backup. Verify a second
durable copy before deletion. Expired upstream Actions data cannot be recovered;
record availability without claiming a backup of bytes GitHub no longer serves.
Do not put private source inputs, repository variables or raw inventories in
public documentation.

Existing signing configuration was transferred directly through sealed GitHub
secret updates, without logging or local plaintext storage. The independent
[verification run](https://github.com/openagent-uno/openagent/actions/runs/41428714304)
confirmed all 26 configured value copies and the common macOS signing team.
The original App/CLI/server configurations are retained separately as secrets;
only names and aggregate evidence belong in documentation. Remove the temporary
migration authorization and fingerprint secrets after their jobs finish.

Tests and signing checks establish specific artifact behavior. They do not
claim provider acceptance, installation on a user's device or a production
deployment. Publish a final dated receipt with source/destination counts,
digests, build and verification evidence before recording retirement complete.
