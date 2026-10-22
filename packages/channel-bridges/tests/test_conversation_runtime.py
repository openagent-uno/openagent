"""Two actors use one real public Core/SQLite runtime, not a channel bot clone.

Provider SDKs and the model executor are deterministic fixtures. This proves
the public host seam and durable run/session behavior, not provider acceptance.
"""
from dataclasses import replace
from hashlib import sha256
import json

import pytest

from openagent_core import (CapabilityCatalog, ExecutionContext, FunctionSource,
    PrincipalRef, RunRequest, Runtime, RuntimeServices, RuntimeSettings,
    SessionRef, ToolDefinition)
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import (BridgeCapabilities, BridgeContext,
    BridgePart, BridgeReply)


class CurrentPolicy:
    def __init__(self):
        self.active = {"alice", "bob", "carol", "bob-new"}

    async def authorize(self, context, action, resource, *, audience=()):
        return (context.tenant_id == resource.tenant_id == "tenant"
                and context.author == context.initiator == context.authority
                and context.author.subject_id in self.active
                and all(p.subject_id in self.active for p in (*context.audience, *audience)))


class CurrentHost:
    """Example host mapping, deliberately outside the provider bridge package."""
    def __init__(self, runtime, store, policy, mapping):
        self.runtime, self.store, self.policy, self.mapping = runtime, store, policy, mapping
        self.enabled = True

    async def start(self):
        return BridgeCapabilities()

    async def stop(self):
        pass

    async def authorize_context(self, context):
        descriptor = context.conversation
        if (not self.enabled or descriptor is None or context.binding_id != "binding"
                or context.provider != "slack" or context.account_id != "team"):
            return False
        return all(self.mapping.get(actor) in self.policy.active for actor in descriptor.audience_ids)

    async def authorize_delivery(self, context):
        return await self.authorize_context(context)

    async def resolve(self, context):
        if not await self.authorize_context(context):
            raise PermissionError("current actor or audience is not authorized")
        descriptor = context.conversation
        pairs = [(actor, self.mapping[actor]) for actor in descriptor.audience_ids]
        # Principal rebinding is a host epoch, separate from provider membership.
        epoch = json.dumps(pairs, ensure_ascii=False, separators=(",", ":"))
        session = "host-shared-v1-" + sha256((descriptor.session_key + epoch).encode()).hexdigest()
        actor = PrincipalRef("host", "tenant", self.mapping[context.actor_id])
        audience = tuple(PrincipalRef("host", "tenant", user) for _, user in pairs)
        return ExecutionContext(actor, actor, actor, session, "agent", audience)

    async def send(self, request, *, on_event=None):
        context = await self.resolve(request.context)
        key = sha256(json.dumps(request.context.deduplication_key).encode()).hexdigest()
        text = "".join(part.text or "" for part in request.parts)
        await self.runtime.submit(RunRequest(key, context.session_id, key, text), context)
        record = await self.runtime.wait(key, context)
        assert record.status == "success", record.output
        if not await self.authorize_delivery(request.context):
            raise PermissionError("audience changed before disclosure")
        return BridgeReply((BridgePart(text=record.output),),
                           session_ref=context.session_id, run_ref=key)

    async def history(self, context):
        resolved = await self.resolve(context)  # Fresh host policy precedes store access.
        return await self.store.read_session(SessionRef("host", "tenant", "agent", resolved.session_id),
                                             resolved, limit=100)


class Channel(BaseBridge):
    name = "slack"
    async def _run(self):
        pass


@pytest.mark.asyncio
async def test_multi_actor_shared_sessions_threads_restart_and_fresh_audience(tmp_path):
    policy = CurrentPolicy()
    mapping = {"external-a": "alice", "external-b": "bob", "external-c": "carol"}
    catalog = CapabilityCatalog(policy)
    note = tmp_path / "vault" / "fact.txt"
    tool_calls = []

    async def memory(args, context):
        tool_calls.append((context.author.subject_id, context.session_id))
        if args["text"] == "remember shared fact":
            note.parent.mkdir(exist_ok=True)
            note.write_text("One agent, one vault")
        return {"structuredContent": {"text": note.read_text() if note.exists() else "empty"}}

    source = FunctionSource((ToolDefinition("memory", "Host-authorized memory", {}),), {"memory": memory})
    catalog.register("host-memory", source, source, target_label="Same agent vault")

    class Executor:
        async def execute(self, request, context, runtime):
            tools = await catalog.discover(context)
            result = await catalog.call_tool(tools[0].tool_ref, {"text": request.input}, context)
            return result["structuredContent"]["text"]

    async def start():
        store = SqliteRuntimeStore(tmp_path / "runtime.sqlite")
        runtime = Runtime(RuntimeSettings("agent", tmp_path),
                          RuntimeServices(store, Executor(), policy, catalog))
        await runtime.start()
        host = CurrentHost(runtime, store, policy, mapping)
        return runtime, host, Channel(transport=host)

    context = BridgeContext("binding", "slack", "team", "external-a", "channel-one", "event-1",
        conversation_kind="channel", audience_ids=("external-a", "external-b"),
        audience_complete=True, audience_verified_at=1.0)
    runtime, host, bridge = await start()
    try:
        first = await bridge.send_message("remember shared fact", context=context)
        bob = replace(context, actor_id="external-b", event_id="event-2",
                      audience_ids=("external-b", "external-a"), audience_verified_at=2.0)
        second = await bridge.send_message("read as bob", context=bob)
        assert first["text"] == second["text"] == "One agent, one vault"
        assert tool_calls[0][1] == tool_calls[1][1]
        assert [actor for actor, _ in tool_calls] == ["alice", "bob"]
        run_key = sha256(json.dumps(bob.deduplication_key).encode()).hexdigest()
        accepted = await host.store.accepted_request(run_key)
        assert accepted.author.subject_id == accepted.authority.subject_id == "bob"
        page = await host.history(bob)
        assert {m["text"] for m in page["messages"]} >= {"remember shared fact", "read as bob"}
        shared_session = tool_calls[-1][1]
        for other in (replace(bob, conversation_id="channel-two", event_id="event-3"),
                      replace(bob, conversation_kind="thread", thread_id="thread-one", event_id="event-4"),
                      replace(bob, conversation_kind="thread", thread_id="thread-two", event_id="event-5")):
            await bridge.send_message("separate scope", context=other)
            assert tool_calls[-1][1] != shared_session
            assert "read as bob" not in {m["text"] for m in (await host.history(other))["messages"]}
        assert len({session for _, session in tool_calls}) == 4
        await bridge.stop()
    finally:
        await runtime.close()

    runtime, host, bridge = await start()
    try:
        # New bridge/runtime/store instances reuse the same normal durable journal.
        before = len(tool_calls)
        await bridge.send_message("read as bob", context=bob)
        assert len(tool_calls) == before  # Exact event replay never re-executes tools.
        assert "read as bob" in {m["text"] for m in (await host.history(bob))["messages"]}
        added = replace(bob, event_id="event-6", audience_ids=("external-c", "external-b", "external-a"))
        await bridge.send_message("new audience", context=added)
        assert tool_calls[-1][1] != shared_session
        assert "read as bob" not in {m["text"] for m in (await host.history(added))["messages"]}
        mapping["external-b"] = "bob-new"
        await bridge.send_message("rebound actor", context=replace(bob, event_id="event-7"))
        assert tool_calls[-1][0] == "bob-new" and tool_calls[-1][1] != shared_session
        policy.active.remove("alice")
        before = len(tool_calls)
        with pytest.raises(PermissionError):
            await bridge.send_message("do not disclose", context=replace(bob, event_id="event-8"))
        with pytest.raises(PermissionError):
            await host.history(bob)
        assert len(tool_calls) == before
        host.enabled = False
        with pytest.raises(PermissionError):
            await bridge.send_message("disabled", context=replace(bob, event_id="event-9"))
    finally:
        await bridge.stop()
        await runtime.close()
