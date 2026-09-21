# MCP and capabilities

OpenAgent v1.1 uses one capability catalog for every tool. The model receives
the same opaque `ToolRef` contract whether a capability is implemented by a
Core module, an external MCP server, the host product or an authenticated
desktop client.

**MCP now means only the protocol used to connect external MCP servers.** Vault,
Sessions, Scheduler, Workflows, Events, Models and other OpenAgent domains
expose native capabilities from their own optional modules. They are not
special built-in MCP servers.

## MCP module modes

The host enables `openagent-module-mcp` with one catalog mode:

| Mode | Catalog ownership | Agent manager tools |
| --- | --- | --- |
| `fixed` | Sources declared by the product | No |
| `managed` | Product changes sources through the host API | No |
| `dynamic` | Product plus an authorized agent | Yes |

The former `mcp-manager` is the `agent_tools` surface of the MCP module in
`dynamic` mode. It manages MCP resources only; it cannot install packages or
enable OpenAgent modules.

```python
ModuleConfig(
    surfaces={"service", "agent_tools", "host_api"},
    options={"catalog_mode": "dynamic"},
)
```

GlassPalace normally uses `managed`; its control plane owns connector and MCP
policy. Replio can use `fixed`. The standalone full profile uses `dynamic`.

## Discovery and invocation

The active catalog returns a name, description, JSON schema and opaque
reference. Invocation always uses that exact reference:

```python
result = await capability_catalog.call_tool(tool_ref, arguments)
```

The registry binds the source, executor, destination, instance and generation.
Arguments cannot redirect “Shell — Mac di Alice” to another computer. If that
executor disconnects or is revoked, a later call fails; OpenAgent does not fall
back to an agent pod or another device.

MCP results preserve structured content, attachments, errors and metadata.
Every route—agent tools, host API, workflows, PTC and imports—uses the same
dispatcher and authorization checks.

## Changes during a run

Adding an MCP updates the catalog for the next admitted run, including the next
turn in the same session. The current run keeps the prompt and schemas captured
at admission. Removing or revoking a source prevents new calls immediately,
including calls through an older `ToolRef`.

Persistent workflows store references to durable sources and resolve them again
at execution time. Temporary desktop capabilities are never converted into a
durable bearer token.

## Client and computer capabilities

OpenAgent App and CLI may register filesystem, editor, shell,
computer-control, agent-in-chrome and dashboard capabilities for the verified
client instance. Those tools come from
[`openagent-tools`](https://github.com/openagent-uno/openagent-tools) or the
standalone product package, not from Core.

Only the originating interactive turn and its authorized child sessions can use
them. Telegram, another app connection, scheduled work and delayed automation
do not inherit them. See [Client Computer Capabilities](./client-capabilities.md).

## Tool Discovery

Tool Discovery is an optional Core module. When its `agent_tools` surface is
enabled it contributes capability discovery and the framework rules that require
the model to:

- discover before declaring a capability unavailable;
- use exact catalog references and the correct destination;
- prefer canonical structured tools over shell workarounds;
- track long-running work and verify results before claiming completion;
- avoid bypassing services through direct database or filesystem writes.

The standalone full profile enables it. A minimal product can omit it and expose
only a small fixed native catalog.
