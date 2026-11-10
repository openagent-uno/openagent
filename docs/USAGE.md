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

## Ephemeral task runner

For on-demand execution (one container or job per task, nothing left running),
use [`apps/server/deploy/task-runner`](../apps/server/deploy/task-runner/README.md).
`openagent-task-run` starts the complete standalone server in a disposable
agent directory, joins it with the first-user invitation, applies optional
REST setup and runs one turn with `openagent-cli ask`, then stops everything.
The scripted building blocks are public commands: `openagent invite
--first-user --ticket-only`, `openagent-cli connect --no-interactive`,
`openagent-cli request [--batch-file]` and `openagent-cli ask --json`.

The runner consumes its inputs: configuration, setup batch and message are
read into memory and unlinked before the server starts, and setup and message
reach the CLI on stdin. An input it cannot remove (a read-only Secret volume)
fails the run before any agent turn, so hand inputs over through a private
writable directory; on Kubernetes, an init container copies the Secret into
an `emptyDir` with `medium: Memory` that only the runner mounts.
`--keep-inputs` is for inputs without secrets. The agent's host tools still
run as the server's account and can read what the server holds (agent
configuration, database, sidecar environment): disable `shell`, `filesystem`
and `editor` when a task does not need them and give each run scoped,
short-lived credentials. The runner README has the Job layout and the full
boundary.

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

Scheduled run details show the run's available summary when its transcript is
missing or the signed-in account lacks access to the linked session. Known
scheduler timeouts include the time limit in the run's error message.

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

## Switch agents in the App

After adding an agent, use the avatar rail to the left of navigation to switch
in the same window. Hover or focus an avatar to identify the agent; the rail
shows the thumbnail or an initial. Use **+** to sign in with another invite.
Double-click an avatar on desktop or hold it on mobile to remove its saved
login. Removing a login leaves the agent and conversations on the server.
With no saved logins, the full-screen sign-in form opens.

The desktop app warms saved logins with remembered credentials in the
background. Switching between ready agents reuses their authenticated
connections. Desktop uses one Iroh endpoint for its device identity. Each
agent tunnel keeps its own certificate and can close independently.
A login without a remembered credential may need its password
the first time. The saved login already supplies the username and network.
If an older login lacks a pinned destination, the app looks up that network's
registered agents and offers a choice when several are available. It saves
the selected destination after sign-in.

Set a thumbnail next to the name in **Settings → Agent Identity**. The current
server stores the image as part of the owner-managed identity, and sends the
presentation to authenticated clients. An older server allows the app to
keep the thumbnail on that device until the server is upgraded. See
[bot profile synchronization](site/guide/channels.md#bot-profile-synchronization)
for the provider requirements.

In **Settings → Members → Agent access**, the primary owner can choose who
can consult Scheduled, Workflows, Events, Connectors and Agent Identity.
**All members** is the default: active network members see automation names
and status, connector summaries and the agent's name and thumbnail. Full
definitions, run history, provider connections and edits retain their owner
permissions. **Owner only** disables the member views.

Use **Transfer ownership** to assign the coordinator agent to another active
username. For federated agents, edit the owner in the coordinator's
**Members → Agents** list. The equivalent remote CLI commands are:

```sh
openagent-cli agent-access show
openagent-cli agent-access visibility members
openagent-cli agent-access transfer-owner USERNAME
openagent-cli agent-access transfer-owner USERNAME --federated-agent AGENT_HANDLE
```

If the agent has no primary owner, the coordinator host operator must assign
one first using `openagent network set-owner USERNAME` (add `--agent AGENT_HANDLE`
for a federated agent). This changes the registered owner without replacing
the agent's handle, keys, or login. It does not move personal provider
credentials to the new owner.

**Models & Providers** includes subscription accounts and provider-reported
usage windows alongside model and provider setup. **Costs** includes both
usage and budget limits. Standalone no longer seeds or runs the legacy
quality scorer, quality digest or cost observability tasks. Upgrade disables
those reserved tasks and keeps their run history and existing custom tasks.
Use private custom dashboards and explicitly granted schedules for domain
observability.
