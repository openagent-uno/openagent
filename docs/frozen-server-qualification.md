# Frozen standalone server

The server executable is assembled from installed public distribution wheels.
The specification does not add checkout source paths or install dependencies.
Use an isolated Python 3.12 environment, install the release's complete
hash-locked requirements, and provide the already verified native device bundle:

```sh
export OPENAGENT_HOST_TOOLS_BUNDLE=/absolute/path/to/verified/darwin-arm64
export OPENAGENT_RELEASE_BUILD=1
export LITELLM_LOCAL_MODEL_COST_MAP=True
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
bash apps/server/scripts/build-executable.sh
```

The selected environment must be first in PATH. The preflight checks the
installed OpenAgent distribution versions. The release wheelhouse and lock
must include core, storage, optional module assets, identity, product packages,
providers, channel dependencies and PyInstaller. Compiled vault resources come
from `openagent-modules`; Python modules are imported from the frozen archive.
Node comes from the device bundle. No npm build runs against an installed wheel.

The specification includes framework prompt resources, SQL migrations,
distribution metadata, LiteLLM's extensionless tokenizer tables, and native
dependencies. Already compiled module and sidecar assets preserve their original
bytes and executable bits: automatic Mach-O thinning or resigning would invalidate
the module manifest. The frozen `_audio-worker` entry dispatches before server configuration or
identity initialization. Its missing-route rejection is included in the smoke.

The outer executable remains subject to the product's
separate signing and notarization workflow.

Run the installed-binary qualification from an environment containing the MCP
SDK, which is used only by the test driver:

```sh
python tests/verify_frozen_server.py \
  --binary apps/server/dist/openagent \
  --evidence /absolute/path/to/qualification-output
```

Every child server receives an empty PATH and a fresh HOME and temporary root.
The test checks version, help and selfcheck; starts a real Iroh gateway against
a disposable marked fixture; verifies every packaged vault artifact hash;
executes the included Node runtime; discovers all 15 vault tools; writes and
reads a note; proves a failed patch leaves the note intact; and discovers the
four tools of the compiled Python budget MCP. It verifies shutdown and removal
of the frozen extraction directory. It never uses a real user database or
downloads provider or voice models.

The first macOS arm64 qualification used core integration snapshot 8, product
snapshot 10 and the six `tools-final` wheels, all version `1.0.0b1`. Its binary
SHA-256 is `5c5ac892374b9bbb02518833a11016369f696dc272e96db8780ed36ecbd689ae`.
The evidence directory contains `frozen-server-build-manifest.json`, the complete
`frozen-server-requirements.lock`, build logs and `frozen-server-verification.json`.
Those receipts describe the development artifact before Developer ID signing.
Signing changes the binary digest and requires a new final artifact receipt.

This frozen smoke uses the marked local fixture bootstrap. Real authenticated
CLI/Electron provider conversations have separate qualification receipts against
installed wheels. The smoke does not qualify a production provider, updater
transition, Windows/Linux server executable or macOS notarization.

For local signing, `scripts/sign-notarize-macos.sh` accepts `CSC_NAME` and,
when creating a package, `CSC_INSTALLER_NAME` for existing keychain identities.
This path does not export certificates, create a keychain or change its search
list. CI retains the explicit certificate-import path. Stage the already signed
Node and computer-control helper before sealing the server App; their identifiers,
team and entitlements are checked and preserved. Installer generation does not
install the package or modify the currently installed application.

The final local runtime smoke used core snapshot12, product snapshot13 and the
same tools-final distributions. It passed against the Developer ID signed
executable with SHA-256
`84168a7a0a6e9db390198a3c6c7eefd647a6be92c99b2fb1aab4a5593d9108ea`.
The public HTTP MCP adapter disables ambient proxy and certificate settings.
`artifacts/frozen-server-verification.json` records the exact binary and runtime
checks; the external `frozen-core12` evidence directory holds all input wheel
hashes and the complete 140-distribution dependency lock. Signing/notarization
receipts describe package qualification separately from a real installation;
no generated installer has been applied to the user's system.

The final server App was notarized and stapled; Gatekeeper accepts it. The
signed archive and exact signature metadata are recorded in
`artifacts/frozen-server-distribution.json`. The installer payload was generated,
but `productsign` requires the user's login-keychain password for the existing
Installer key. Until that macOS dialog is completed, the `.pkg` is not a signed,
notarized release artifact. No credentials were exported or requested in chat,
and no key-access policy was changed.
