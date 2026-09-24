# Build and release contracts

Use Python 3.11 or newer. All commands resolve paths relative to the workspace,
so they also work when launched from another directory.

```sh
python3.11 scripts/workspace.py list
python3.11 scripts/workspace.py verify-history
python3.11 scripts/workspace.py run cli -- python -m pytest
python3.11 scripts/workspace.py wheel mcp-bridge --output dist/wheels
python3.11 scripts/workspace.py release-manifest --artifacts dist/artifacts --output dist/release-manifest.json
```

The wheel command builds the selected component with `uv build` from a clean
temporary snapshot of tracked and unignored source files. It never reuses
setuptools `build/lib` directories. To build all nine Python components:

```sh
python3 scripts/build_wheels.py --out /absolute/path/to/empty-output
```

The builder rejects overlapping import payloads across wheels and writes a
manifest with source hashes, package versions, SHA-256 digests, and whether
the source snapshot contains uncommitted changes. Use a new empty output
directory for each build. This prevents an old CLI wheel from overwriting
the separately owned client transport package.
Runtime dependencies are resolved by the consuming product's locked build;
they are not silently fetched as unpinned source checkouts. Packaging a wheel
does not claim a runnable, signed desktop release.

`packaging/workspace.json` preserves public distribution and command names,
artifact prefixes, legacy update repositories, app ID, URL scheme and user
paths. Imported component release workflows remain under their original
subtrees as reference. Only explicitly ported root workflows execute in the
monorepo.

The generated release manifest records the exact product commit, individual
component versions, SHA-256 and size of every supplied artifact, source
history and compatibility flags. The wheel builder's `manifest.json` is hashed
as build evidence instead of being assigned to a product component; the
technical `.gitignore` emitted by `uv` is excluded. It rejects symbolic links and ambiguous or
unknown artifact ownership. The caller must supply separate protocol,
storage and signing evidence in a qualification receipt before publishing a
coordinated `v1.1.0-beta.N` release. A development manifest is not a signature
or a qualification claim.

Never change production update endpoints solely because source moved.
Publish a separately qualified transition release in each old repository,
preserving historical assets and immutable tags. Verify the entire installed
version → transition → new distribution → next update chain before retiring
old development. User identity keys, application IDs and consent files retain
their existing paths throughout.

## Local macOS qualification

Use the existing Developer ID identity and entitlements. The host bundle must
be signed and notarized before staging into Electron. Set `CSC_NAME` to an
existing keychain identity for `packages/host-tools/scripts/sign_macos_bundle.sh`;
its CI path still imports the supplied certificate into an isolated temporary
keychain. The local path never exports a private key or changes the keychain
search list. Notarization credentials are supplied by the caller, never saved
in a repository or printed in build output.

After notarization and stapling, regenerate the host bundle manifest and use
a local consumer lock containing that manifest digest. `after-sign-host-tools`
verifies that Electron preserved the nested signatures, bundle IDs, team and
bytes. Keep production consumer locks and update endpoints unchanged until a
release artifact is published and independently qualified.

`desktop-real-iroh.spec.mjs` supports `OPENAGENT_E2E_PACKAGED_APP` to exercise an
actual installed `.app` with its bundled renderer and host tools. It uses an
explicit temporary profile and a temporary server. Without that variable,
the same scenario runs the current Electron development build.

`desktop-updater-chain.spec.mjs` accepts `OPENAGENT_UPDATE_CHAIN_MANIFEST` with
three signed local archives and their expected SHA-256/version/feed namespace.
It copies the existing application into a temporary directory and runs the
real electron-updater/Squirrel install path through loopback feeds. The
original application and user data are preserved. Stable builds continue to
reject beta feeds; synthetic fixture version numbers used to qualify a future
stable transition are recorded separately from the actual beta release.

See [runtime qualification](runtime-and-verification.md) and
[frozen server qualification](frozen-server-qualification.md) for evidence and
remaining distribution gates.

## Native bundle CI after Python beta 9

The root `Host tools native bundles` workflow is an explicit manual gate. It
checks out the exact selected `main` commit, downloads the Core beta 5,
Tools beta 3 and host-tools beta 4 wheels, and builds all six native targets.
It runs host-tools tests and native sidecar smoke checks on every target.
`signing_mode=ci` signs, notarizes, and verifies both macOS archives in CI and
produces a proposed `release-index.json` consumer lock. `signing_mode=local`
uploads unsigned six-platform candidate archives without a release index;
sign both macOS bundles locally, regenerate their manifests and archives, and
run `release_index.py` on the merged set only after independent verification.
`packages/host-tools/scripts/finalize_local_signing.sh` performs those steps
from the downloaded candidate directory into a new output directory. Pass the
workflow's exact source commit as its third argument and run it with the
released-wheel Python environment plus `CSC_NAME`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` in the environment. It checks
all six detached archive hashes and manifest contents before writing the lock;
the two macOS archives are signed and notarized again from the CI candidates.
Neither mode publishes an App release or changes an updater feed. Review the
lock, publish the component archives under a `v1.0.0b4` tag on this repository
at the workflow source commit, then update App/CLI/server consumer locks before
packaging those products.

The CI signing mode requires `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as Actions secrets on the
**`openagent`** repository. These names currently exist only on the historical
`openagent-app` repository. Configure them on the monorepo through GitHub's
secret controls; do not paste values into chat, source files or CI logs. The
CI mode fails before starting its matrix when any required secret is absent.
This is a CI configuration gate, not a macOS signing limitation: the local
Developer ID identity and notarization credential can qualify a macOS bundle
with `CSC_NAME` through `sign_macos_bundle.sh`, without exporting the private
key or changing the keychain search list.

The workflow's macOS arm64 path was rehearsed locally from the released
wheelhouse: 17 focused host-tools tests passed, PyInstaller and the Rust
sidecar built, the sidecar catalog snapshot matched, and the bundled MCP smoke
passed with real display/window discovery, input, screenshots and browser
interaction. The resulting bundle was then signed with the existing Developer
ID identity, accepted by Apple notarization (submission
`cd437d1d-d225-4b4f-a36e-704a87eee355`), stapled, rehashed, and repackaged.
The extracted archive passed strict code-signature checks for the host, Node,
and computer-control helper, plus stapler and Gatekeeper validation. Its
SHA-256 is
`ed7b59f0c2c11f470705bc6382ae5a62a36d26bdca37672d3289c348cc099f1e`.
This is a local qualification artifact, not a published release asset. The
other five platform jobs, six-platform consumer lock, and updated App/CLI
installers still require qualification.
