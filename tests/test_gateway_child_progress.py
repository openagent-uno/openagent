"""Child progress belongs to the exact turn that admitted the child."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from openagent_core.stream.collector import StreamCollector
from openagent_server.bridges.gateway_transport import GatewayBridgeTransport


@pytest.fixture(autouse=True)
def local_telegram_shutdown(monkeypatch):
    # These bots have a local gateway but no Telegram polling subscription.
    monkeypatch.setattr("openagent_channel_bridges.telegram.TelegramBridge.flush_updates_offset", AsyncMock())


@pytest.mark.asyncio
async def test_child_progress_never_finishes_or_pollutes_parent_and_late_frames_are_dropped():
    transport = GatewayBridgeTransport()
    parent = StreamCollector()
    parent.on_status = AsyncMock()
    parent.on_child = AsyncMock()
    transport._stream_pending['parent'] = parent
    await transport._handle_gateway_frame(dict(type='status', session_id='parent', text=json.dumps(
        dict(child_session_id='child', tool_name='delegate_task_to_member'))))
    await transport._handle_gateway_frame(dict(type='status', session_id='child', text='Reading fixture'))
    await transport._handle_gateway_frame(dict(type='text_delta', session_id='child', text='private child text'))
    assert parent.on_child.await_count == 2
    assert not parent.done.is_set()
    assert not parent.accumulated_text
    replacement = StreamCollector()
    replacement.on_child = AsyncMock()
    transport._stream_pending['parent'] = replacement
    await transport._handle_gateway_frame(dict(type='status', session_id='child', text='late old progress'))
    replacement.on_child.assert_not_awaited()
    assert not replacement.done.is_set()
    assert not transport._child_routes
    await transport.stop()


@pytest.mark.asyncio
async def test_new_input_after_stop_waits_for_cancelled_terminal_and_gets_a_new_collector():
    from openagent_core.stream.events import OutTextFinal, TurnComplete
    from openagent_client_transport.stream.wire import event_to_wire
    transport = GatewayBridgeTransport()
    transport._send_gateway_json = AsyncMock()
    transport._stream_opened.add('parent')
    old = StreamCollector()
    transport._stream_pending['parent'] = old
    command = asyncio.create_task(transport._legacy_command_full('stop', session_id='parent'))
    await asyncio.sleep(0)
    fresh = asyncio.create_task(transport._legacy_send_message('new input', 'parent'))
    await asyncio.sleep(0)
    await transport._handle_gateway_frame(dict(type='command_result', text='Stopped'))
    await command
    assert transport._send_gateway_json.await_count == 1
    assert transport._stream_pending['parent'] is old
    await transport._handle_gateway_frame(event_to_wire(TurnComplete(session_id='parent', reason='cancelled')))
    async with asyncio.timeout(2):
        while transport._stream_pending['parent'] is old:
            await asyncio.sleep(.001)
    assert not transport._stream_pending['parent'].done.is_set()
    await transport._handle_gateway_frame(event_to_wire(OutTextFinal(session_id='parent', text='new answer')))
    await transport._handle_gateway_frame(event_to_wire(TurnComplete(session_id='parent')))
    assert (await fresh)['text'] == 'new answer'
    await transport.stop()


class Receipt:
    def __init__(self, chat_id, text):
        self.chat_id = chat_id
        self.text = text
        self.edits = []

    async def edit_text(self, text, **_):
        self.text = text
        self.edits.append(text)

class TelegramMessage:
    chat_id = 100
    message_id = 1
    message_thread_id = None
    reply_to_message = None
    chat = SimpleNamespace(id=100, type="private")
    from_user = SimpleNamespace(id=100)

    def __init__(self):
        self.posts = []
        self.pulses = 0
        self.bot = SimpleNamespace(id=900, get_chat=self.get_chat, send_chat_action=self.send_chat_action)

    def get_bot(self):
        return self.bot

    async def get_chat(self, **_):
        return self.chat

    async def send_chat_action(self, **_):
        self.pulses += 1

    async def reply_text(self, text, **_):
        receipt = Receipt(self.chat_id, text)
        self.posts.append(receipt)
        return receipt


@pytest.mark.asyncio
@pytest.mark.parametrize("live", [False, True])
async def test_configured_telegram_turn_progress_over_gateway_websocket(tmp_path, live):
    from aiohttp import web
    from openagent_client_transport.stream.wire import event_to_wire
    from openagent_core.core.config import load_config
    from openagent_core.stream.child_stream import child_frame_to_event
    from openagent_core.stream.events import OutTextDelta, OutTextFinal, OutToolStatus, TurnComplete
    from openagent_server.server import _build_bridges

    admitted = asyncio.Queue()
    ingress = []

    async def gateway(request):
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        await socket.send_json({"type": "auth_ok"})
        async for frame in socket:
            value = frame.json()
            ingress.append(value["type"])
            if value["type"] == "text_final":
                await admitted.put((socket, value["session_id"]))
        return socket

    async def wait_visible(index, value):
        async with asyncio.timeout(1):
            while len(target.posts) <= index or value not in target.posts[index].text:
                await asyncio.sleep(.001)
        assert not turn.done()

    config = tmp_path / "openagent.yaml"
    config.write_text(
        "channels:\n  telegram:\n    token: 900:fixture\n"
        f"    allowed_users: ['100']\n    live: {str(live).lower()}\n"
    )
    application = web.Application()
    application.router.add_get("/ws", gateway)
    runner = web.AppRunner(application)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    target = TelegramMessage()
    bridge, = _build_bridges(load_config(config), {"telegram": f"ws://127.0.0.1:{port}/ws"})
    bridge.turn_edit_interval = 0  # Deterministic pacing, while keeping the real message pump.
    await bridge._ensure_transport_started()
    turn = asyncio.create_task(bridge.dispatch_turn(target, "tg:100", "fixture turn",
        context=bridge._bridge_context(target)))
    try:
        socket, parent = await asyncio.wait_for(admitted.get(), 2)
        child, second = "child-fixture", "second-child-fixture"

        async def child_event(kind, text="", *, session=child):
            event = child_frame_to_event({"kind": kind, "session_id": session, "text": text})
            await socket.send_json(event_to_wire(event))

        assert ingress == ["auth", "session_open", "text_final"]
        await socket.send_json(event_to_wire(OutTextDelta(session_id=parent, text="Parent progress")))
        if live:
            await wait_visible(0, "Parent progress")
        await socket.send_json(event_to_wire(OutToolStatus(session_id=parent, text=json.dumps({
            "tool_name": "read_file", "tool_call_id": "parent-tool",
        }))))
        if live:
            await wait_visible(0, "Reading")
        await socket.send_json(event_to_wire(OutTextDelta(session_id="unlinked", text="Unrelated secret")))
        await socket.send_json(event_to_wire(OutToolStatus(session_id=parent, text=json.dumps({
            "tool_name": "delegate_task_to_member", "tool_call_id": "delegation",
            "tool_args": {"member_id": "Fixture delegate"}, "child_session_id": child,
        }))))
        await child_event("seed", "Private child input")
        if live:
            await wait_visible(1, "Fixture delegate")
        await child_event("delta", "Child working")
        await child_event("delta", " progressively")
        if live:
            await wait_visible(1, "Child working progressively")
        await child_event("delta", " [FILE:/discard/")
        await child_event("status", json.dumps({"tool_name": "read_file", "tool_call_id": "child-tool"}))
        if live:
            await wait_visible(1, "Reading")
            assert "Child working progressively" in target.posts[1].text
        await child_event("delta", "fictional]")
        await socket.send_json(event_to_wire(OutToolStatus(session_id=parent, text=json.dumps({
            "tool_name": "delegate_task_to_member", "tool_call_id": "second-delegation",
            "tool_args": {"member_id": "Second delegate"}, "child_session_id": second,
        }))))
        await child_event("delta", "Independent narration", session=second)
        if live:
            await wait_visible(2, "Independent narration")
            assert "Independent narration" not in target.posts[1].text
        await child_event("response", "Child final preview [FILE:/discard/fictional]", session=child)
        await child_event("response", "Second final", session=second)
        if live:
            await wait_visible(1, "Child final preview")
            await wait_visible(2, "Second final")
            assert "/discard/fictional" not in target.posts[1].text
        else:
            await asyncio.sleep(.025)
            assert target.pulses >= 1 and target.posts == [] and not turn.done()
        await child_event("turn_complete")
        await child_event("turn_complete", session=second)
        if live:
            await wait_visible(1, "Completed")
            await wait_visible(2, "Completed")
        await socket.send_json(event_to_wire(OutTextFinal(session_id=parent, text="Final parent reply")))
        await socket.send_json(event_to_wire(TurnComplete(session_id=parent)))
        await asyncio.wait_for(turn, 2)
        assert target.posts[0].text == "Final parent reply"
        assert len(target.posts) == (3 if live else 1)
        if live:
            assert target.posts[1].text.endswith("Completed") and "Child final preview" in target.posts[1].text
            assert target.posts[2].text.endswith("Completed") and "Second final" in target.posts[2].text
        visible = [text for receipt in target.posts for text in [receipt.text, *receipt.edits]]
        assert all("Unrelated secret" not in value and "Private child input" not in value
                   and "/discard/" not in value for value in visible)
    finally:
        if not turn.done():
            turn.cancel()
            await asyncio.gather(turn, return_exceptions=True)
        await bridge.stop()
        await runner.cleanup()


@pytest.mark.asyncio
async def test_gateway_delivers_parent_after_revoked_child_and_early_child_failure(tmp_path, monkeypatch):
    from dataclasses import replace

    from aiohttp import ClientSession, web
    from aiohttp.test_utils import TestServer
    from openagent_core.contracts import ExecutionContext, PrincipalRef, RunRequest
    from openagent_core.memory.db import MemoryDB
    from openagent_core.memory.legacy_document_history import SessionProjectionGuard
    from openagent_core.stream.child_stream import current_child_stream_emitter
    from openagent_server.bootstrap import prepare_agent
    from openagent_server.bridges.telegram import TelegramBridge
    from openagent_server.gateway.server import Gateway
    from openagent_storage_sqlite import SqliteRuntimeStore

    db = MemoryDB(str(tmp_path / "gateway.sqlite"))
    store = SqliteRuntimeStore(tmp_path / "gateway.sqlite")
    failed, restricted = "fixture-failed", "fixture-restricted"
    parent_reply = "The delegated work could not finish. This is the final parent reply."
    failure = "fixture child error details"
    withheld = "withheld child update"
    allowed = {failed, restricted}
    linked, revoked, finish_parent = asyncio.Event(), asyncio.Event(), asyncio.Event()
    recorded = []

    class Agent:
        name = "fixture-agent"
        memory_db = db
        model = None

        async def refresh_registries(self):
            return False, 1

        async def run_stream(self, *, message, session_id, on_status, **kwargs):
            emit = current_child_stream_emitter()
            actor = PrincipalRef("openagent", "test-network", "fixture")
            parent_context = ExecutionContext(actor, actor, actor, session_id, self.name, (actor,))
            await store.accept(RunRequest("parent-run", session_id, "parent-key", message), parent_context)
            await store.transition("parent-run", "running")
            await store.bind_document_sources(parent_context, "parent-run", ("fixture-document",))
            allowed.add(session_id)
            for child in (failed, restricted):
                child_context = replace(parent_context, session_id=child, parent_run_id="parent-run")
                await store.accept(RunRequest(child, child, child, "fixture delegation"), child_context)
                # Represent an early failure without a materialized child transcript.
                await conn.execute("DELETE FROM session_messages WHERE session_id=?", (child,))
                await conn.commit()
                assert await store.document_sources(child_context, session_id=child) == ("fixture-document",)
                await on_status(json.dumps({"tool_name": "delegate_task_to_member", "tool_call_id": child,
                    "tool_args": {"member_id": child}, "child_session_id": child}))
            await emit({"kind": "status", "session_id": restricted, "text": "Starting work"})
            await revoked.wait()
            await emit({"kind": "delta", "session_id": restricted, "text": withheld})
            await store.transition(failed, "failed", output={"error_type": "AuthorizationDenied"})
            await emit({"kind": "turn_complete", "session_id": failed, "reason": "error", "error": failure})
            await finish_parent.wait()
            await store.transition(restricted, "failed", output={"error_type": "AuthorizationDenied"})
            await emit({"kind": "turn_complete", "session_id": restricted, "reason": "error", "error": failure})
            await store.transition("parent-run", "success", output=parent_reply)
            yield {"kind": "done", "text": parent_reply}

    async def authorize(sid):
        if sid not in allowed:
            raise PermissionError("Session access ended")

    @web.middleware
    async def fixture_identity(request, handler):
        request["auth_kind"] = "agent"
        request["device_cert"] = SimpleNamespace(handle="fixture", network_id="test-network",
            device_pubkey_hex="abcd", device_pubkey=bytes.fromhex("abcd"), capabilities=("bridge",))
        request["openagent_session_projection"] = SessionProjectionGuard(authorize)
        return await handler(request)

    async def text_stream_only(session, _gateway):
        await session.start(stt_factory=None, tts_factory=None)

    monkeypatch.setattr("openagent_server.gateway.server.start_stream", text_stream_only)
    monkeypatch.setattr("openagent_server.bridges.gateway_transport.BRIDGE_COALESCE_WINDOW_MS", 0)
    gateway = Gateway(Agent(), SimpleNamespace(network_name="fixture"))
    app = web.Application(middlewares=[fixture_identity])
    app.router.add_get("/ws", gateway._handle_ws)
    server = TestServer(app)
    await server.start_server()
    url = str(server.make_url("/ws")).replace("http://", "ws://")
    bridge = TelegramBridge(token="900:fixture", gateway_url=url, allowed_users=["100"], live=True)
    transport = bridge.transport
    bridge.turn_edit_interval = 0
    target = TelegramMessage()
    handle_frame = transport._handle_gateway_frame

    async def observe_wire(frame):
        recorded.append(frame)
        await handle_frame(frame)
        if frame.get("session_id") == restricted and frame.get("type") == "status":
            linked.set()

    monkeypatch.setattr(transport, "_handle_gateway_frame", observe_wire)
    turn = None
    try:
        await prepare_agent(gateway.agent, {"_local_e2e": True})
        await store.start()
        conn = await db._ensure_connected()
        await bridge._ensure_transport_started()
        turn = asyncio.create_task(bridge.dispatch_turn(target, "tg:100", "fixture turn",
            context=bridge._bridge_context(target)))
        async with asyncio.timeout(10):
            await linked.wait()
            allowed.remove(restricted)
            revoked.set()
            while not any(frame.get("type") == "turn_complete" and frame.get("session_id") == failed
                          for frame in recorded):
                await asyncio.sleep(.005)
            # Reconnect during the still-running parent. Its snapshot may contain
            # the delegation status, while child bodies and terminals keep their own scope.
            async with ClientSession() as client, client.ws_connect(url) as observer:
                await observer.send_json({"type": "ping"})
                snapshots = []
                while True:
                    frame = await observer.receive_json()
                    if frame["type"] == "pong":
                        break
                    if frame["type"] == "live_state":
                        snapshots.append(frame)
            parent = next(frame["session_id"] for frame in recorded if frame.get("type") == "status")
            assert [snapshot["session_id"] for snapshot in snapshots] == [parent]
            assert all(frame.get("session_id") == parent for frame in snapshots[0]["frames"])
            assert withheld not in str(snapshots)
            finish_parent.set()
            await turn
        assert [frame["type"] for frame in recorded if frame.get("session_id") == parent][-2:] == [
            "response", "turn_complete"]
        assert not any(frame.get("session_id") == restricted and frame.get("type") in {"delta", "turn_complete"}
                       for frame in recorded)
        child_rows = await (await conn.execute(
            "SELECT count(*) FROM session_messages WHERE session_id IN (?,?)", (failed, restricted))).fetchone()
        assert child_rows[0] == 0
        assert len(target.posts) == 3
        assert parent_reply in [receipt.text for receipt in target.posts]
        assert f"Delegated to sub-agent · {failed}\n\nFailed" in [receipt.text for receipt in target.posts]
        assert all(withheld not in str(receipt.edits) and failure not in str(receipt.edits)
                   for receipt in target.posts)
    finally:
        revoked.set()
        finish_parent.set()
        if turn is not None and not turn.done():
            turn.cancel()
            await asyncio.gather(turn, return_exceptions=True)
        await bridge.stop()
        await server.close()
        for key in list(gateway._stream_sessions):
            await gateway._close_stream_session(key)
        await store.close()
        await db.close()


@pytest.mark.asyncio
async def test_realtime_retries_queued_parent_final_on_closed_socket_until_rebound():
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from openagent_client_transport.stream.wire import event_to_wire, wire_to_event
    from openagent_core.stream.channel import RealtimeChannel
    from openagent_core.stream.events import OutTextFinal, TurnComplete
    from openagent_core.stream.session import StreamSession
    from openagent_server.gateway.server import Gateway

    sockets = asyncio.Queue()

    async def endpoint(request):
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        await sockets.put(socket)
        async for _frame in socket:
            pass
        return socket

    app = web.Application()
    app.router.add_get("/ws", endpoint)
    agent = SimpleNamespace(name="fixture")
    gateway = Gateway(agent, SimpleNamespace(network_name="fixture"))
    session = StreamSession(agent, client_id="fixture", session_id="parent")
    async with TestClient(TestServer(app)) as client:
        original = await client.ws_connect("/ws")
        old_socket = await sockets.get()
        await original.close()
        retry = asyncio.Event()

        async def send_on_original(frame):
            handled = await gateway._safe_ws_send_json(old_socket, frame)
            if not handled:
                retry.set()
            return handled

        channel = RealtimeChannel(session, send_on_original, encoder=event_to_wire, decoder=wire_to_event)
        channel.RETRY_INTERVAL_S = .01
        try:
            await channel.start()
            await session.outbound.put(OutTextFinal(session_id="parent", text="Retained reply"))
            await session.outbound.put(TurnComplete(session_id="parent"))
            async with asyncio.timeout(2):
                await retry.wait()
                async with client.ws_connect("/ws") as replacement:
                    new_socket = await sockets.get()
                    channel.rebind(lambda frame: gateway._safe_ws_send_json(new_socket, frame))
                    response = await replacement.receive_json()
                    assert (response["type"], response["text"]) == ("response", "Retained reply")
                    assert (await replacement.receive_json())["type"] == "turn_complete"
        finally:
            await channel.close()
