# Using the standalone components

Read [components](COMPONENTS.md) and [agnostic architecture](AGNOSTICISM.md).
Commands below describe supported entry points; this documentation update does
not install, start, publish or migrate a live agent.

## Inspect the checkout

Use a Python **3.11+** interpreter on PATH (verify with `python3 --version`):

```sh
python3 scripts/workspace.py list
python3 scripts/workspace.py run server -- python3 -m pip --version
```

`list` reads component manifests without starting a runtime. `run` changes to the
component's directory and executes the command after `--`. It is not an installer
or a dependency resolver. Versions in different repositories need not be equal;
use the pinned compatible wheel set, not `pip install -e` overlays in deployed builds.

## Standalone server

Install a verified complete standalone release according to
[getting started](site/guide/getting-started.md) and [build/release](build-and-release.md).
The distribution is `openagent-framework`, the command is `openagent`.

```sh
openagent init ./my-agent
openagent serve ./my-agent
```

`init` creates a new owned agent directory; `serve` starts its configured host.
Follow [configuration](site/guide/config-reference.md) for model/provider setup,
identity and channels. Do not run this example against an existing directory
as an implicit migration. Preserve state, vault, keys, grants and single-writer
ownership when upgrading; see the dated release/restore gates.

## CLI and App

Install `openagent-cli` from the same qualified product release. Connect it using
the verified invite/identity flow in getting started; use
`openagent-cli --help` and `openagent-cli connect --help` for the current options.
Do not copy a saved ticket, token or identity into documentation.

The packaged App combines Electron desktop with the shared Expo renderer. For
source development, use the locked Node toolchain and local package manifests:

```sh
cd apps/app/universal
npm ci
npm run web
```

For the desktop shell, from `apps/app/desktop`, run `npm ci` then `npm run dev`.
Use the normal configured OpenAgent identity/connection flow. These source
commands are not signed installers, not a second agent server and not native
device acceptance. Build/check scripts and capabilities are in the respective
package.json files and [client guide](site/guide/client-capabilities.md).

## MCP bridge

`openagent-mcp` serves MCP over stdio and connects to explicitly configured peer
agents. It reads `OPENAGENT_MCP_CONFIG`, an operator-owned TOML path. Start it
from the MCP client's process configuration; it does not replace `openagent serve`.
See [the component example](../apps/mcp-bridge/examples/targets.example.toml)
and [entry point](../apps/mcp-bridge/src/openagent_mcp/__main__.py). Keep actual
identity material outside versioned examples.

## Shared channel bridges

Install `openagent-channel-bridges` with only the required provider extra. A host
implements the public `BridgeTransport`, current actor/audience checks and
delivery binding, then registers the bridge with its existing runtime.
Use [package README](../packages/channel-bridges/README.md),
[protocol](../packages/channel-bridges/PROTOCOL.md) and
[embedding guide](site/guide/embedded-channels.md). The bridge translates events;
it neither forks the agent loop nor creates another vault. Changes go to this
shared package and remain usable by any conforming host.

## Embed libraries instead of the standalone host

Use `openagent-core` directly for a verified in-process Runtime, or its optional
HTTP gateway/SDK for a remote run service. Use independent Tools for capabilities.
You do not need standalone identity, server bootstrap, App or dashboard packages
unless your integration explicitly selects them. Follow the
[Core usage guide](https://github.com/openagent-uno/openagent-core/blob/main/docs/USAGE.md)
and [Tools usage guide](https://github.com/openagent-uno/openagent-tools/blob/main/docs/USAGE.md).

## Build and verification

`python3 scripts/workspace.py wheel server --output /an/owned/artifact-directory`
uses the product's wheel builder; it does not release the result. Use
[build/release](build-and-release.md) for the full exact artifact set, native
sidecar pins, updater bridges, checksums and qualification. Imported component
workflows are historical until ported to the root `.github/`. Source tests,
closed-wheel tests, signed GUI, external provider acceptance and rollout remain
different evidence levels.
