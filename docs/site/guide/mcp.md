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

The active catalog first returns compact, ranked pages containing names,
short descriptions and opaque references. A large source can be narrowed by
capability words instead of returning dozens of full schemas at once:

```text
tool_search_list_tools(source_ref, query="create adset", limit=10)
tool_search_describe_tool(tool_ref)
```

The second call returns the selected tool's complete JSON schema. Invocation
then uses that exact reference in the same run:

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

Starting with host-tools `1.0.0b2`, the editor also exposes `apply_patch` for verified unified-diff edits to one
existing file at a time. The shell exposes `shell_processes` for a structured
process list containing only PID and executable name; command lines and
environment variables are excluded. Both use the same client or server
destination as their parent capability and are discoverable through Tool
Discovery without any new model-facing dispatch path.

Only the originating interactive turn and its authorized child sessions can use
them. Telegram, another app connection, scheduled work and delayed automation
do not inherit them. See [Client Computer Capabilities](./client-capabilities.md).

The standalone full profile also registers `filesystem`, `editor` and `shell`
for the server workspace. These are durable product-owned destinations and are
therefore available to Telegram and automation when authorized. They operate on
the machine running `openagent`, never on a connected user's computer. Configure
them independently:

```yaml
server_host_tools:
  enabled: true
  tools: [filesystem, editor, shell]
```

Set `server_host_tools: false` to run a session-only server, or list only the
tools the deployment should expose. The shell subprocess receives runtime safety
and sandbox policy but does not inherit channel or provider credentials.

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

## Optional Meta Ads package

OpenAgent Tools `v1.0.0-beta.2` publishes the optional
[`@openagent-uno/meta-ads-mcp-server`](https://github.com/openagent-uno/openagent-tools/releases/tag/v1.0.0-beta.2)
package. It preserves the upstream catalog and adds
`meta_ads_upload_ad_video`, including conversion of ordinary Google Drive share
links to a direct download URL accepted by Meta.

Write operations remain opt-in with `META_ADS_ENABLE_WRITE_TOOLS=true`. With
that flag enabled the source exposes 55 tools, including image and video upload;
without it the write tools stay absent. Video upload returns a `video_id` that
can be polled with `meta_ads_get_ad_video` before it is used in a creative.

Install the release asset into an immutable deployment directory and configure
the MCP source to execute its `meta-ads-mcp` binary. Pin the asset digest from
the release manifest instead of resolving an npm package dynamically at service
startup.
