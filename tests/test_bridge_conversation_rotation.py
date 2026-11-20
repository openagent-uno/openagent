"""The next channel turn must use the conversation that reset actually created."""
from types import SimpleNamespace
import asyncio

import pytest

from openagent_core.engine import MemoryDB
from openagent_core.chat_commands import ChatCommandRequest, ChatCommandService, SessionRef
from openagent_server.bridges.gateway_transport import GatewayBridgeTransport
from openagent_server.bridges.session_identity import (
    conversation_route_key, resolve_conversation_route,
)
from openagent_server.gateway.command_host import GatewayCommandHost


@pytest.mark.asyncio
async def test_channel_reset_preserves_history_and_survives_reconnect(tmp_path):
    db = MemoryDB(str(tmp_path / "agent.db"))
    await db.connect()
    old, other = "telegram:" + "a" * 64, "telegram:" + "b" * 64
    released, stopped, attached = [], [], []

    async def release(sid):
        released.append(sid)

    async def interrupt(client, sid, **kwargs):
        stopped.append(sid)
        return False

    manager = SimpleNamespace(
        stop_current=lambda *a, **k: False,
        clear_queue_for_session=lambda *a, **k: 0,
        get_or_create_session=lambda client, sid, **k: attached.append(sid),
    )
    agent = SimpleNamespace(memory_db=db, release_session=release)
    gateway = SimpleNamespace(agent=agent, sessions=manager, _interrupt_stream_sessions=interrupt)
    try:
        await db.upsert_session(old, client_id="owner", title="Original conversation")
        await db.upsert_session(other, client_id="another", title="Unrelated conversation")
        await db.pin_session_model(old, "example:reasoner")
        host = GatewayCommandHost(gateway, "a" * 64, "__bridge_telegram")
        result = await ChatCommandService(agent, host).execute(ChatCommandRequest("new", SessionRef(old)))
        assert result.status == "completed"
        fresh = await resolve_conversation_route(db, old)
        assert fresh != old and fresh.startswith(old + ":conversation:")
        assert stopped == released == [old]
        assert attached == [fresh]
        assert (await db.get_session(old))["title"] == "Original conversation"
        assert (await db.get_session(other))["title"] == "Unrelated conversation"
        assert await db.get_session_pin(fresh) == "example:reasoner"
        assert await resolve_conversation_route(db, other) == other

        from openagent_channel_bridges.contracts import BridgePart
        transport = GatewayBridgeTransport()
        transport.configure_session_routes(db)
        transport._session_for_context = lambda _: old
        transport._bridge = SimpleNamespace(_delivery_mode="live")
        calls = []
        async def authorized(_): return True
        async def send(text, sid, **kwargs):
            calls.append((text, sid))
            return {"type": "response", "text": "Fresh response", "status": "completed"}
        transport.authorize_context = authorized
        transport._legacy_send_message = send
        reply = await transport.send(SimpleNamespace(context=SimpleNamespace(provider="telegram", actor_id="42"),
            parts=(BridgePart(text="New question"),), history=(), source="text"))
        assert calls == [("New question", fresh)]
        assert reply.session_ref == fresh

        # A new transport and DB connection cannot fall back to the original ID.
        await db.close()
        db = MemoryDB(str(tmp_path / "agent.db"))
        await db.connect()
        transport = GatewayBridgeTransport()
        transport.configure_session_routes(db)
        transport._session_for_context = lambda _: old
        assert await transport.resolve_session(None) == fresh

        # A second reset replaces the same bounded pointer, never chains IDs.
        gateway.agent.memory_db = db
        result = await ChatCommandService(agent, host).execute(ChatCommandRequest("reset", SessionRef(fresh)))
        newer = await transport.resolve_session(None)
        assert result.status == "completed" and newer != fresh
        assert newer.startswith(old + ":conversation:") and newer.count(":conversation:") == 1
        assert await db.get_session(fresh) is not None
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_rotation_storage_failure_is_not_acknowledged_and_keeps_old_history(tmp_path):
    db = MemoryDB(str(tmp_path / "agent.db"))
    await db.connect()
    try:
        await db.upsert_session("tg:123", title="Keep me")
        async def release(_): pass
        async def interrupt(*a, **k): return False
        async def fail(*a): raise OSError("private storage detail")
        agent = SimpleNamespace(memory_db=db, release_session=release)
        manager = SimpleNamespace(stop_current=lambda *a, **k: False,
            clear_queue_for_session=lambda *a, **k: 0)
        gateway = SimpleNamespace(agent=agent, sessions=manager, _interrupt_stream_sessions=interrupt)
        host = GatewayCommandHost(gateway, "bridge:telegram", "__bridge_telegram")
        db.set_state = fail
        result = await ChatCommandService(agent, host).execute(ChatCommandRequest("new", SessionRef("tg:123")))
        assert result.status == "failed" and "not reset" in result.text
        assert "private storage" not in result.text
        assert await db.get_state(conversation_route_key("tg:123")) is None
        assert (await db.get_session("tg:123"))["title"] == "Keep me"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_message_waiting_old_drain_reads_committed_fresh_route(tmp_path):
    from openagent_core.stream.collector import StreamCollector
    from openagent_channel_bridges.contracts import BridgePart
    db = MemoryDB(str(tmp_path / "agent.db"))
    await db.connect()
    old, fresh = "tg:123", "tg:123:conversation:" + "a" * 32
    transport = GatewayBridgeTransport()
    transport.configure_session_routes(db)
    transport._session_for_context = lambda _: old
    entered = asyncio.Event()
    class Drain:
        async def wait(self):
            entered.set()
            await proceed.wait()
    proceed = asyncio.Event()
    transport._stopping_sessions = {old: SimpleNamespace(done=Drain())}
    async def authorized(_): return True
    async def prepare(_): pass
    transport.authorize_context = authorized
    transport._bridge = SimpleNamespace(_delivery_mode="live", _prepare_delivery_context=prepare)
    frames = []
    async def wire(frame):
        frames.append(frame)
        if frame.get("type") == "text_final":
            transport._stream_pending[frame["session_id"]].done.set()
    transport._send_gateway_json = wire
    task = None
    try:
        task = asyncio.create_task(transport.send(SimpleNamespace(
            context=SimpleNamespace(provider="telegram", actor_id="123"),
            parts=(BridgePart(text="New question"),), history=(), source="text")))
        await asyncio.wait_for(entered.wait(), 2)
        await db.set_state(conversation_route_key(old), fresh)
        proceed.set()
        reply = await asyncio.wait_for(task, 2)
        assert reply.session_ref == fresh
        assert [f["session_id"] for f in frames] == [fresh, fresh]
    finally:
        if task and not task.done(): task.cancel()
        await db.close()


@pytest.mark.asyncio
async def test_queued_commands_and_message_select_route_after_reset_commits(tmp_path):
    from openagent_channel_bridges.contracts import BridgePart
    db = MemoryDB(str(tmp_path / "agent.db"))
    await db.connect()
    old = "tg:123"
    first, second = (old + ":conversation:" + x * 32 for x in ["a", "b"])
    transport = GatewayBridgeTransport()
    transport.configure_session_routes(db)
    transport._session_for_context = lambda _: old
    transport._bridge = SimpleNamespace(_delivery_mode="live")
    context = SimpleNamespace(provider="telegram", actor_id="123", conversation_kind="direct")
    entered, proceed = asyncio.Event(), asyncio.Event()
    calls, frames = [], []
    async def authorized(_): return True
    async def command(name, sid, arg):
        calls.append(sid)
        if len(calls) == 1:
            entered.set()
            await proceed.wait()
        await db.set_state(conversation_route_key(old), first if len(calls) == 1 else second)
        return {"status": "completed", "text": "Fresh conversation"}
    async def wire(frame):
        frames.append(frame)
        if frame.get("type") == "text_final":
            transport._stream_pending[frame["session_id"]].done.set()
    transport.authorize_context = authorized
    transport._legacy_command_full = command
    transport._send_gateway_json = wire
    tasks = []
    try:
        request = SimpleNamespace(context=context, name="new", argument=None)
        tasks.append(asyncio.create_task(transport.command(request)))
        await asyncio.wait_for(entered.wait(), 2)
        tasks.append(asyncio.create_task(transport.command(request)))
        # Wait until the second command is queued on the admission boundary.
        await asyncio.sleep(0)
        tasks.append(asyncio.create_task(transport.send(SimpleNamespace(context=context,
            parts=(BridgePart(text="After reset"),), history=(), source="text"))))
        await asyncio.sleep(0)
        assert frames == []
        proceed.set()
        results = await asyncio.wait_for(asyncio.gather(*tasks), 2)
        assert calls == [old, first]
        assert results[-1].session_ref == second
        assert [f["session_id"] for f in frames] == [second, second]
    finally:
        for task in tasks:
            if not task.done(): task.cancel()
        await db.close()


@pytest.mark.asyncio
async def test_route_cannot_select_another_actor_or_hide_storage_failure(tmp_path):
    db = MemoryDB(str(tmp_path / "agent.db"))
    await db.connect()
    try:
        await db.set_state(conversation_route_key("tg:123"), "tg:456:conversation:" + "a" * 32)
        with pytest.raises(ValueError, match="Invalid stored"):
            await resolve_conversation_route(db, "tg:123")
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_shared_or_unauthorized_reset_does_not_read_or_stop_any_session():
    transport = GatewayBridgeTransport()
    touched = []

    async def authorized(context):
        return context.actor_id == "allowed"

    async def command(*args):
        touched.append(args)
        raise AssertionError("A refused reset must not reach a session")

    transport.authorize_context = authorized
    transport._legacy_command_full = command
    for actor in ["allowed", "denied"]:
        request = SimpleNamespace(name="new", argument=None,
            context=SimpleNamespace(actor_id=actor, conversation_kind="group"))
        if actor == "denied":
            with pytest.raises(PermissionError):
                await transport.command(request)
        else:
            assert (await transport.command(request)).status == "unsupported"
    assert touched == []


def test_rotated_owner_route_keeps_exact_account_actor_and_private_audience():
    from openagent_core.contracts import ExecutionContext, PrincipalRef
    from openagent_server.bridge_vault_access import owner_bridge_vault_turn
    from openagent_server.bridges.session_identity import gateway_bridge_session_id

    config = {"channels": {"telegram": {"token": "123:fixture", "allowed_users": ["42", "43"]}},
        "runtime_tool_audiences": {"vault_owner_channels": {"telegram": ["42"]}}}
    principal = PrincipalRef("openagent", "network", "__bridge_telegram", "user")
    def context(actor="42", account="123"):
        sid = gateway_bridge_session_id("telegram", "telegram", account, actor, actor, None, "tg:" + actor)
        return ExecutionContext(initiator=principal, author=principal,
            authority=principal, audience=(principal,), agent_id="agent",
            session_id=sid + ":conversation:" + "a" * 32)
    assert owner_bridge_vault_turn(context(), config)
    assert not owner_bridge_vault_turn(context("43"), config)
    assert not owner_bridge_vault_turn(context(account="124"), config)
