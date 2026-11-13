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
artifact prefixes, canonical release repositories, app ID, URL scheme and user
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

The owner explicitly chose manual migration for installations using retired
repository feeds on 2 November 2026. New builds use the canonical repository;
old updater URLs may stop working after retirement. Follow
[the migration procedure](release-consolidation.md): preserve historical
artifacts and signing identities, qualify the newly built updater, and keep user
identity keys, application IDs, profiles and consent files at their existing paths.
Do not uninstall or erase a profile as part of manual migration.

## Current canonical publication

The current manual-upgrade cohort is product 1.1.9 beta 10 and App beta26. Use the reviewed
native build and canonical publisher workflows described in
[the current migration/publication procedure](release-consolidation.md).
Python Host Tools B15 and its six signed/qualified native bundles have distinct
qualification scopes; the App preserves the original signed computer helper. The six-platform App and all four feed files are public;
old distribution repositories are retired. Historical recipes below retain
original attribution and are not current release destinations.

## Local iOS device build

The universal client can be compiled locally with Xcode and CocoaPods. Use the
Expo SDK-compatible React Native dependency versions in the App lockfile. From
`apps/app/universal`, run `npm ci`, then from `apps/app`:

```sh
./build.sh ios --device <device-udid>
```

This runs `expo run:ios --configuration Release`: it generates the ignored
native project, signs and installs a Release app with its JavaScript bundled,
so launching it does not require a Metro development server. Set
`OPENAGENT_APPLE_TEAM_ID` to an existing authorized Apple development team when
generating the project. Signing credentials remain in Xcode/the keychain. The
iOS bundle identifier is `ai.openagent.app`; the marketing version and beta
build number come from `universal/package.json`. Install updates in place to
preserve any existing application data.

The iOS build includes native iroh-ffi transport (v0.35.0) with SRP-6a
authentication, CBOR coordinator RPC, and Keychain credential storage via
expo-secure-store. The iroh-ffi version must stay wire-compatible with the
`iroh==0.35.0` pin of the server, CLI and desktop: iroh 0.90+ cannot handshake
with 0.35 peers, and the failure shows up only as a dial timeout. The
`Iroh.xcframework` binary is not tracked; fetch the `IrohLib.xcframework.zip`
asset of the iroh-ffi release named in `ios/Vendor/IrohLib/IrohLib.podspec`
(v0.35.0, SHA-256
`be3115dc21039ba621c2b5ae07a5b289cd0a36efbe8623c89cd55bc0523bbadb`) into
`ios/Vendor/IrohLib/`. `ios/OpenAgent/IrohLib.swift` is the matching UniFFI
binding from the same tag. The native transport is abstracted behind `PlatformTransport`
so the desktop Electron path remains unchanged. The shared protocol code lives
in `apps/app/common/network/`; native Swift modules are in the Xcode project
under `ios/OpenAgent/`.

This is a local development-signed installation, not an App Store or TestFlight
release.

## Local macOS qualification reference

This local developer route is separate from the historical B6 remote CI release
procedure recorded below; it is not required to consume the published bundles.

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

## Historical native bundle release: Host Tools B6 (14 October 2026)

[Host Tools B6](https://github.com/openagent-uno/openagent/releases/tag/v1.0.0b6)
is published from canonical source `aa8dafb3ef14066dbdaadbbf66bc9b3a00b801e0`,
with 16 asset digests/sizes verified against the qualified output. The consumer
release-index SHA-256 is
`a0f85b84e6d98f525c466126df7a5de9437d9628127607517a94f1b61b1889e0`.
The [canonical native workflow](https://github.com/openagent-uno/openagent/actions/runs/38457527270)
built six targets remotely with matrix parallelism one and bounded native
workers two. The [versioned signing bridge](https://github.com/openagent-uno/openagent-app/actions/runs/38467343111)
reused the existing Apple credentials in their original executor repository;
no secret copying or export to the monorepo was needed. Both Mac native
signature/notary/archive gates passed. [Final assembly](https://github.com/openagent-uno/openagent-app/actions/runs/38471673047)
reused those exact signatures, preserving the four other native archives and
Python wheel byte-for-byte. `qualification.json`, `release-index.json` and
`SHA256SUMS` in the public release record source and executor provenance.
Windows Authenticode is not claimed; Linux ARM64 browser navigation was not
exercised. App beta 17 is staged separately and is not a published native App
release. Subsequent product builds consume this public lock; they do not inherit
provider OAuth or host storage acceptance from the component checks.

## Historical native bundle procedure: Python beta 9 / App and CLI beta 10

The following procedure and receipts describe the earlier beta 9/10 rollout,
including its local signing option and then-proposed secret configuration.
They are retained as history, not the current B6 remote signing instructions.

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
**`openagent`** repository. The signing settings were securely migrated and independently verified on
2 November 2026; see [the migration gates](release-consolidation.md). Manage them
through GitHub's secret controls; do not paste values into chat, source files or CI logs. The
CI mode fails before starting its matrix when any required secret is absent.
This is a CI configuration gate, not a macOS signing limitation: the local
Developer ID identity and notarization credential can qualify a macOS bundle
with `CSC_NAME` through `sign_macos_bundle.sh`, without exporting the private
key or changing the keychain search list.

The six-platform matrix passed on
[run 36035151417](https://github.com/openagent-uno/openagent/actions/runs/36035151417)
at source commit `37f8f907f72809cd4589bdbd146e8c85733e2d67`. Both macOS
candidates were signed with the existing local Developer ID identity,
notarized by Apple (submissions
`32d61e5c-44ca-497d-8726-ca9fe1b15297` and
`08f4ba77-eade-4cd0-bc52-f847c061995a`), stapled, and checked with
strict code-signature and Gatekeeper verification. All six archive and wheel
digests were independently checked against the generated consumer index.
The exact 14 assets are published at
[`v1.0.0b4`](https://github.com/openagent-uno/openagent/releases/tag/v1.0.0b4),
with the release index SHA-256
`42f723ee3738e0f0188a7f9e152de09ef3bb7e75791c30bb59566078c2cb29a9`.
The App and CLI beta 10 locks consume that published index. Qualification of
their distributable artifacts and updater paths is recorded separately in the
product release receipt.

## Manual channel component workflow

Host Tools B15 copies the complete qualified helper from the pinned public
Device Tools wheel. macOS packaging verifies its signature, team and existing
stapled ticket without signing or stapling it again. Only the host facade and
its Node runtime are signed by this packaging workflow; the assembled bundle
still passes notarization. This preserves the upstream native artifact bytes.

Run `42219813682` qualified all six native Host Tools B15 archives and their
consumer index from source `57addfae2ca7dfc24148e0f93e515a01bc17e0ab`.
The installer consumes the public wheel, checksum-pinned acquisition helper and
native index. It installs the complete native bundle in a versioned directory
and links the installed Device Tools discovery directory to that verified root.
This includes the browser's Node runtime and dependencies without installing
dependencies into a source checkout or changing runtime code. Existing
independently managed discovery directories are preserved.

Host Tools B16 changes only the shell dependency: it consumes Tools release
`v1.0.0-beta.7` (shell and execution `1.0.0b4`, the other wheels byte-identical
to `v1.0.0-beta.6`). On macOS the shell resolves `PATH` from the user's login
shell when the App starts the host from Finder or the Dock, and `shell_exec`
refuses sub-second timeouts instead of terminating the command. The shell entry
of `builtins-lock.json` changes with its schema; Device Tools stays at
`1.0.0b18`.

Host Tools B17 consumes `openagent-capability-host` `1.0.0b4` from Core release
`v1.1.0-beta.87`: a principal's own parallel mutating calls wait a bounded time
for the mutating lease instead of failing with `lease_held`, while other
principals are still refused at once. The shared local broker now reports its
version in the control handshake; a client replaces an older broker (or a
verified legacy broker without a version) before connecting, and broker
teardown is bounded even with clients connected. Tools stay at
`v1.0.0-beta.7` and Device Tools at `1.0.0b18`; `builtins-lock.json` is
unchanged.

Host Tools B18 gives shell commands started by the App the user's login
`PATH` on macOS. The capability host used to pass its own process environment
to the shell server explicitly, so the shell's login-`PATH` resolution (added in
B16) never ran and a broker started by launchd saw only the system `PATH`. The
host now leaves the default to the shell server; an environment passed
explicitly is still used exactly as given. Dependencies are unchanged from B17.

`publish-host-tools.yml` reuses the successful signed producer's exact artifact
on a GitHub runner. A maintainer first creates the reviewed immutable version
tag and draft. The publisher binds the eight successful jobs, producer commit,
version, tag and installation-cohort manifest digest. It resumes only matching
private draft assets, never overwrites uploaded bytes, and verifies every
published asset through anonymous HTTPS before completing. Native build and
signing are not repeated during publication.

Product packaging tests qualify these delivery contracts and standalone
workspace/environment policy. Former tests of private Core browser and native
implementations were replaced by host composition contracts; those
implementations and their native acceptance now belong to Tools qualification.

`Channel bridge wheel` is a manually dispatched component-only producer. Select
an exact reviewed public source SHA and expected package version. The read-only
builder uses the canonical wheel command on a standard public Linux runner,
checks tracked source hashes and wheel bytes, and qualifies the normally installed
wheel with the full provider-free suite on the pinned Core/SQLite beta45 pair.
It neither builds a native application nor calls a real messaging provider.

The builder passes only the small public wheel and provenance through bounded job
outputs; it does not create an Actions artifact or cache. A separate publisher job
has ephemeral `contents: write` authority, atomically creates a previously absent
component tag, uploads a draft prerelease, downloads and compares all uploaded
bytes, and then publishes. It refuses an existing tag and never replaces assets
or retries a failed publication. A failed draft/tag remains for explicit review.
Anonymous public download verification and consumer adoption are separate gates.

## Python product cohorts

`.github/workflows/product-python-release.yml` builds the seven coupled product wheels
and the independently versioned product-configuration wheel
on a hosted Linux runner from a clean source commit, installs the public pinned
Core cohort and runs both root tests and the deterministic Custom Views protocol
suite. Tag publication consumes those qualified exact wheel artifacts and refuses
to overwrite an existing release. `scripts/qualify_python_product.py` verifies
source provenance, versions, direct URL digests and installed import ownership.
Native App and Host Tools releases stay independent for server-only changes.

The installer is bound after the wheel manifest digest is known: update its
product/Core manifest pins, qualify the complete installed closure, then upload
the exact installer and provenance receipt to that same immutable release.
Verify every public asset's digest and size before host rollout. A wheel-only
release does not by itself prove the installer, native App or deployed host.

A maintainer may also promote the unchanged artifact of a successful manual
candidate run: verify its source commit, clean manifest, installed tests and
wheel digests, create the immutable tag at that exact commit, and publish those
same artifacts. Cancel a redundant tag-triggered build rather than replacing
the qualified wheels with a rebuild. Keep the qualification run in the public
receipt and never overwrite a published asset.


## Exact first-party wheel qualification

The Python product qualifier verifies each selected wheel digest and normally
reinstalls that exact first-party closure before resolving third-party
dependencies. An already installed distribution with the same version cannot
stand in for the reviewed artifact. This matters when the bootstrap contains
an older independently packaged wheel. Installed package and native checks
still run before publication; source tests alone are not release acceptance.

The App universal TypeScript configuration resolves its shared source package
imports against the universal consumer's own node_modules using exact runtime
package aliases. It never aliases runtime imports to type-only declarations. Icons used directly by App components are explicit locked dependencies.
This keeps a clean CI install equivalent to development without a parent
node_modules symlink or undeclared transitive dependency.
