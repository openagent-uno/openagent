# Standalone components and repository map

Reviewed against `packaging/workspace.json` and component manifests on
**2 November 2026**. Exact versions are reported by the workspace command and
release manifests; source candidates and published/installed builds may differ.
Read [agnostic architecture](AGNOSTICISM.md) before changing behavior.

## Repositories and layers

| Repository | Owns |
| --- | --- |
| `openagent-core` | Generic kernel, optional reasoning engine/modules, operational storage, optional HTTP gateway and Python/TypeScript SDK |
| `openagent-tools` | Independent tools, neutral protocol, process-execution implementations, native/browser sidecars, connector SDK/runner/auth broker |
| `openagent` | Standalone App, CLI, server, MCP bridge, identity, dashboards, transport, channel bridges, packaging and public documentation |

This repository composes public pinned dependencies; it must not contain an
engine/tool fork or embedding-application branches. The public
[component communication guide](site/guide/components.md) explains the full flow.

## Product directory map

| Path / distribution | Responsibility |
| --- | --- |
| `apps/server/` / `openagent-framework`, command `openagent` | Standalone bootstrap, agent directories, identity/network gateway, explicit Runtime/module/Tools composition and lifecycle |
| `apps/app/universal/` | React Native/Expo shared renderer for the OpenAgent App |
| `apps/app/desktop/` | Electron main/preload, verified transport and scoped local capabilities; same shared renderer |
| `apps/app/common/` | Client contracts and capability types shared across renderer/desktop |
| `apps/cli/` / `openagent-cli` | Interactive client; verified connection, replay and explicitly consented local tools |
| `apps/mcp-bridge/` / `openagent-mcp` | MCP stdio client of configured OpenAgent peers; not a second agent engine |
| `packages/identity/` / `openagent-identity` | Standalone device/network identity, enrollment and certificates |
| `packages/client-transport/` / `openagent-client-transport` | Shared client transport used by Python clients, avoiding generated copies |
| `packages/product-config/` / `openagent-product-config` | Standalone configuration/bootstrap contract |
| `packages/channel-bridges/` / `openagent-channel-bridges` | Reusable stateless provider channels and host transport contract; separately versioned |
| `packages/host-tools/` / `openagent-host-tools` | Standalone compatibility/facade around public Core capability host and Tools; no copied tool implementations |
| `packages/dashboards/` / `openagent-dashboards` | Standalone persistent dashboard services; App advertises its own dashboard source |
| `packages/mcp-apps/` | Optional shared MCP App UI host, sandbox and mediated interactions; source-candidate status is separate from a published artifact |
| `packages/integrations/support/` | Optional standalone support integration, not a consumer-specific plugin |
| `docs/site/` | Canonical public site and vision; the separate docs repository is a transition mirror |
| `packaging/`, `scripts/`, root `.github/` | Component pins, source provenance, coordinated builds and active product workflows |

The server is a **host of Core**, not the kernel itself. App and CLI are clients
of that host, not alternative reasoning engines. The optional Core HTTP run
gateway/SDK is a different integration surface from the standalone identity and
Iroh transport; do not substitute one protocol for the other by path guessing.

## Communication and capability boundaries

1. App/CLI authenticate through the standalone transport/identity layer. A channel
   bridge instead verifies its external actor/conversation through its host adapter.
2. The server constructs the verified ExecutionContext and submits work to its
   single Core Runtime. State, admission, idempotency and events remain Core-owned.
3. The reasoning executor chooses enabled modules and registered capability sources.
   Tools run through their exact function/MCP/sidecar/connector executor.
4. Results and progress return through current audience authorization and replay;
   the UI does not infer success from an acknowledged transport request.

App dashboard/local-device sources belong to the authenticated originating turn.
CLI local tools require its own consent. Channels and unattended tasks do not
inherit a connected client's device merely because it is online. The server may
register its own explicit durable tools with different source references.

Channels (`BridgeTransport`) turn provider events into ordinary host requests;
they do not create another Runtime, vault or database. A connector is different:
it exposes a provider API as a tool. MCP bridge is different again: it exposes
configured OpenAgent peers to an MCP client. See [embedded channels](site/guide/embedded-channels.md)
and [shared components](site/guide/shared-components.md).

## Where to make a change

Change generic reasoning/runtime/module behavior in Core; tool behavior or
runner/sidecar/provider adapter behavior in Tools; OpenAgent's client UI,
standalone composition and channel transport in their product package. First
add a public generic extension if one is missing. The reporting consumer's
name or business rule must never become a conditional here.

For use and commands follow [USAGE](USAGE.md). For package boundaries read
[Core components](https://github.com/openagent-uno/openagent-core/blob/main/docs/COMPONENTS.md)
and [Tools components](https://github.com/openagent-uno/openagent-tools/blob/main/docs/COMPONENTS.md).
