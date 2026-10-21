"""Actual public Core dispatch: a channel uses the host runtime and catalog.

The executor and tools are deterministic fixtures, not a live provider claim.
The SQLite run journal and filesystem memory fixture are real and host-owned.
"""
from __future__ import annotations

from dataclasses import replace
from hashlib import sha256

import pytest

from openagent_core import (
    CapabilityCatalog, ExecutionContext, FunctionSource, PrincipalRef, RunRequest,
    Runtime, RuntimeServices, RuntimeSettings, ToolDefinition,
)
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import (
    BridgeCapabilities, BridgeContext, BridgePart, BridgeReply,
)


class Policy:
    async def authorize(self, context, action, resource, *, audience=()):
        return (context.author.subject_id == "alice" and
                context.tenant_id == resource.tenant_id and
                all(person.subject_id == "alice" for person in audience))


class HostTransport:
    def __init__(self, runtime, principal):
        self.runtime, self.principal = runtime, principal
        self.allowed = True
        self.calls = []
        self.stopped = False

    async def start(self):
        return BridgeCapabilities()

    async def stop(self):
        self.stopped = True  # Does not own or close the runtime.

    async def authorize_context(self, context):
        return (self.allowed and context.binding_id == "binding" and
                context.account_id == "team" and context.actor_id == "alice" and
                context.conversation_id == "channel")

    async def send(self, request, *, on_event=None):
        assert await self.authorize_context(request.context)
        self.calls.append(request)
        key = sha256(repr(request.context.deduplication_key).encode()).hexdigest()
        context = ExecutionContext(self.principal, self.principal, self.principal,
                                   "channel-session", "agent", (self.principal,))
        text = "".join(part.text or "" for part in request.parts)
        await self.runtime.submit(RunRequest(key, context.session_id, key, text), context)
        record = await self.runtime.wait(key, context)
        assert record.status == "success", record.output
        return BridgeReply((BridgePart(text=record.output),), session_ref=context.session_id, run_ref=key)


class Channel(BaseBridge):
    name = "slack"
    async def _run(self):
        return


@pytest.mark.asyncio
async def test_channel_and_host_sessions_share_actual_runtime_tools_and_memory(tmp_path):
    principal = PrincipalRef("host", "tenant", "alice")
    policy = Policy()
    catalog = CapabilityCatalog(policy)
    note = tmp_path / "vault" / "learning.md"
    tool_calls = []

    async def memory(args, ctx):
        tool_calls.append((ctx.author, ctx.session_id))
        if args.get("write"):
            note.parent.mkdir(exist_ok=True)
            note.write_text("# Learning\n\nChannel fact\n")
        return {"structuredContent": {"text": note.read_text()}}

    source = FunctionSource((ToolDefinition("memory", "Host memory fixture", {}),), {"memory": memory})
    catalog.register("host-memory", source, source, target_label="Host memory")

    class Executor:
        async def execute(self, request, ctx, runtime):
            tools = await catalog.discover(ctx)
            result = await catalog.call_tool(tools[0].tool_ref,
                                            {"write": request.input == "remember"}, ctx)
            return result["structuredContent"]["text"]

    runtime = Runtime(RuntimeSettings("agent", tmp_path),
                      RuntimeServices(SqliteRuntimeStore(tmp_path / "state.sqlite"),
                                      Executor(), policy, catalog))
    await runtime.start()
    transport = HostTransport(runtime, principal)
    bridge = Channel(transport=transport)
    channel_context = BridgeContext("binding", "slack", "team", "alice", "channel", "event", "thread")
    try:
        result = await bridge.send_message("remember", "routing-hint", context=channel_context)
        assert "Channel fact" in result["text"]
        assert transport.calls[0].context.thread_id == "thread"
        # A normal host session uses exactly the same public catalog and vault.
        host_context = ExecutionContext(principal, principal, principal, "host-session", "agent", (principal,))
        await runtime.submit(RunRequest("host", "host-session", "host", "read"), host_context)
        assert "Channel fact" in (await runtime.wait("host", host_context)).output
        assert tool_calls == [(principal, "channel-session"), (principal, "host-session")]
        # Durable event identity is the host's responsibility, not a channel-local cache.
        await bridge.send_message("remember", "routing-hint", context=channel_context)
        assert len(tool_calls) == 2
        with pytest.raises(PermissionError):
            await bridge.send_message("read", "routing-hint",
                                      context=replace(channel_context, actor_id="mallory", event_id="denied"))
        transport.allowed = False
        with pytest.raises(PermissionError):
            await bridge.send_message("read", "routing-hint", context=replace(channel_context, event_id="revoked"))
        assert len(tool_calls) == 2
        await bridge.stop()
        # Closing a channel does not close the shared agent/runtime.
        await runtime.submit(RunRequest("still-live", "host-session", "still-live", "read"), host_context)
        assert (await runtime.wait("still-live", host_context)).status == "success"
    finally:
        await runtime.close()
