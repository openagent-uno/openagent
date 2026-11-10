# Canonical distribution and manual upgrade

Decision and qualification: **2 November 2026**. The owner chose to retire old
updater URLs and explicitly discard unused historical release assets, including
copies imported during the initial preservation attempt. That choice supersedes
the earlier full-release migration/transfer proposal. No personal-account
repository transfer was performed.

## Published cohorts and ownership

- [Product 1.1.9 beta 10](https://github.com/openagent-uno/openagent/releases/tag/v1.1.9-beta.10)
  supplies seven versioned server/CLI wheels and the complete pinned manual
  installer. Core beta48, Device Tools B18, Host Tools B15, product-config B20
  and channel bridges B19 retain their independent public release identities.
- [App beta26](https://github.com/openagent-uno/openagent/releases/tag/app-v1.1.0-beta.26)
  supplies ten installers/archives across six native targets, with 36 verified
  release assets. macOS ARM64 and x64 are signed, notarized and stapled.
  It inherits the six public Host Tools B15 bundles and preserves the native
  helper's existing signed application identity. Windows Authenticode is not claimed.
- The mutable [App feed](https://github.com/openagent-uno/openagent/releases/tag/app-update-feed)
  contains only four beta channel YAML files. Their absolute URLs reference
  immutable App tag assets, with the original SHA-512 and size. Update metadata
  is generated only after all six platform payloads pass verification.
- Native compatibility releases `host-tools-v0.1.2` and `host-tools-v0.1.3`
  remain because active public dependency locks use their payloads. Source Git
  ancestry/commit identity, binaries, internal manifests and signatures remain
  unchanged; download locator/index metadata is canonical.
- The MCP stdio starter is `openagent-tools/examples/mcp-server`, released as
  `mcp-template-v0.2.0`; its original source ancestry and ref aliases remain.

Generic agent behavior stays in its owning Core/Tools/product component. Hosts
inherit public versioned contracts; domain adapters do not copy or override the
runtime. OpenAgent contains no external consuming-project branches or defaults.

## Manual upgrade and updater behavior

Replace an existing App at the same location. Keep its profile, identity and
agent directories; do not uninstall first or erase data. The ID
`ai.openagent.desktop`, `openagent` protocol, updater cache and consent paths
remain stable. New Windows installers retain application data on uninstall.
Manually selecting beta26 opts into beta; stable/beta separation and the
no-downgrade invariant remain enforced after the updater channel is assigned.

Run the immutable 1.1.9 beta 10 installer for server/CLI. It verifies 39
first-party wheels across nine manifests and acquires the complete native Host
Tools bundle. The server also acquires the pinned connector runner. `OPENAGENT_INSTALL_ROOT` controls the command environment, not an identity
reset. When server and CLI already share the installation root, upgrade both
to the same product version to align their exact-version dependencies.
The installer preserves unrelated commands; choose `--prefix` explicitly
when selecting a different command location.

The server accepts only an exact platform/version native server archive from the
canonical repository. Wheel-only or unrelated releases are not offered as a
frozen-server binary update. GitHub's numeric pagination paths are normalized
back to the canonical owner/name URL; foreign repositories are never followed.
This was checked against 106 actual public releases in two pages.

## Build and publication gates

`.github/workflows/desktop-canonical-release.yml` builds or requalifies reviewed
native artifacts. Windows GUI installers are started through the native shell
and the exact process exit is checked before the installed App smoke test.
The temporary installer profile belongs to the CI job. Requalification of a
frozen installer permits only acceptance/publication-helper source changes;
package, runtime, renderer, lock and native bundle inputs must be unchanged.

`.github/workflows/publish-canonical-desktop.yml` merges platform metadata and
verifies the complete asset union from a fresh publication directory. It checks
uploaded SHA-256/size before publication, then publishes the validated feed.
A five-target baseline is reusable only when the same strict source-diff gate
passes and every reused native job succeeded. Build provenance is recorded in
the App release body.

GitHub's default integration token can reject release creation for reviewed refs
that include workflow history. A maintainer publication authorization can be
provided through `CANONICAL_RELEASE_PUBLISH_TOKEN`; it is scoped to publication
steps, never dependency installation. If Actions cannot create the release, a maintainer can
create an empty prerelease draft for the verified tag and pass its ID via
`existing_draft_release_id`. The publisher checks the draft and source, uploads
the same qualified assets and verifies their hashes before promotion. Temporary publication/retirement tokens
were removed after their jobs. Signing settings remain in the repository's
Actions secrets, not in source, logs or this documentation.

## Preservation, deliberate deletion and evidence

The four old distribution hosts held 334 release records and 3,188 assets
(293,747,689,240 bytes), including nine private App drafts. The owner explicitly
chose to discard release history. Forty-two initial imported/archive copies
(526 assets, 44,641,358,921 bytes) were removed. Useful dependency payloads were
retained separately; do not describe the discarded history as fully backed up.

Source refs/bundles, two App LFS objects, useful repository/issue/PR metadata and
27 unpublished source/provenance inputs were preserved in verified private
canonical draft backups. The unpublished inputs contain 72,074,629 source bytes;
private filenames and raw inventories are not public documentation. Existing
signing configuration was transferred by sealed secret updates. The independent
[verification run](https://github.com/openagent-uno/openagent/actions/runs/41428714304)
confirmed 26 configured value copies and the common signing team without exposing
values. Temporary fingerprint secrets were removed.

The final receipt records native build/publication jobs, public installer and
live pagination acceptance, dependency acquisition and known downstream fixture
limitations. Those historical package/signature/installation checks did not claim live model
or connector-provider acceptance, a user-device upgrade or a production runtime
deployment. The independent 6 November receipt records the newer desktop and
remote-host acceptance scope. Installed user profiles and original concurrent
code checkouts were preserved.
