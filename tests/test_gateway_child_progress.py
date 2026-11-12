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
