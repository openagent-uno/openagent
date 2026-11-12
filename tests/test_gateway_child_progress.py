"""Child progress belongs to the exact turn that admitted the child."""
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
