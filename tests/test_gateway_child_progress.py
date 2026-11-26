"""Child progress belongs to the exact turn that admitted the child."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from openagent_core.stream.collector import StreamCollector
from openagent_server.bridges.gateway_transport import GatewayBridgeTransport


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


@pytest.mark.asyncio
@pytest.mark.parametrize("live", [False, True])
async def test_configured_telegram_turn_progress_over_gateway_websocket(tmp_path, live):
    from types import SimpleNamespace

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

    class Receipt:
        def __init__(self, text):
            self.chat_id = target.chat_id
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
            receipt = Receipt(text)
            self.posts.append(receipt)
            return receipt

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
