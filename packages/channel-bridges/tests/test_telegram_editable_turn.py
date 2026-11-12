import asyncio
from types import SimpleNamespace
import json

import pytest

from openagent_channel_bridges.contracts import BridgeCapabilities, BridgeEvent, BridgePart, BridgeReply
from openagent_channel_bridges.telegram import TelegramBridge
from openagent_channel_bridges.turn_messages import EditableMessage


class Sent:
    def __init__(self, target, text):
        self.chat_id = target.chat_id
        self.message_id = len(target.sent) + 2
        self.text = text
        self.edits = []

    async def edit_text(self, text, **kwargs):
        self.text = text
        self.edits.append(text)


class Message:
    chat_id = 100
    message_id = 1
    message_thread_id = None
    reply_to_message = None
    chat = SimpleNamespace(id=100, type="private")
    from_user = SimpleNamespace(id=100)

    def __init__(self):
        self.sent = []
        self.bot = SimpleNamespace(id=900, get_chat=self.get_chat)

    def get_bot(self):
        return self.bot

    async def get_chat(self, **kwargs):
        return self.chat

    async def reply_text(self, text, **kwargs):
        result = Sent(self, text)
        self.sent.append(result)
        return result


class Transport:
    def __init__(self, produce, answer="Final answer"):
        self.produce, self.answer = produce, answer
        self.allowed = True

    async def authorize_context(self, context):
        return self.allowed and context.actor_id == "100"

    async def start(self):
        return BridgeCapabilities(progress_kinds=("status", "text", "child"))

    async def stop(self):
        pass

    async def send(self, request, *, on_event=None):
        await self.produce(on_event)
        return BridgeReply(parts=(BridgePart(text=self.answer),))


class Bridge(TelegramBridge):
    turn_edit_interval = 0

    async def post_status(self, *args):
        return None


def fixture(produce, answer="Final answer"):
    transport = Transport(produce, answer)
    bridge = Bridge("fixture-token", allowed_users=["100"], transport=transport, binding_id="test")
    message = Message()
    return bridge, message, transport


@pytest.mark.asyncio
async def test_narration_tools_and_final_edit_one_telegram_message():
    async def produce(emit):
        await emit(BridgeEvent("status", "Thinking..."))
        await asyncio.sleep(0)
        for index in range(100):
            await emit(BridgeEvent("text", f"Progress {index}"))
            await emit(BridgeEvent("status", json.dumps({"tool_name": "read_file", "tool_call_id": str(index)})))
        await emit(BridgeEvent("compaction", json.dumps({"phase": "running"})))
        await emit(BridgeEvent("compaction", json.dumps({"phase": "done"})))
    bridge, message, _ = fixture(produce)
    await bridge.dispatch_turn(message, "tg:100", "question", context=bridge._bridge_context(message))
    assert len(message.sent) == 1
    assert message.sent[0].text == "Final answer"
    assert message.sent[0].edits
    await bridge.stop()


@pytest.mark.asyncio
async def test_each_subagent_has_one_separate_message_updated_with_its_own_operation():
    async def produce(emit):
        for child in ("child-one", "child-two"):
            await emit(BridgeEvent("status", json.dumps({"tool_name": "delegate_task_to_member",
                "tool_call_id": child, "child_session_id": child, "tool_args": {"member_id": child}})))
        await asyncio.sleep(0)
        for child in ("child-one", "child-two"):
            for index in range(20):
                await emit(BridgeEvent("child", json.dumps({"session_id": child, "type": "status", "text": f"operation-{child}-{index}"})))
            await asyncio.sleep(0)
            await emit(BridgeEvent("child", json.dumps({"session_id": child, "type": "turn_complete", "reason": "completed"})))
    bridge, message, _ = fixture(produce)
    await bridge.dispatch_turn(message, "tg:100", "question", context=bridge._bridge_context(message))
    assert len(message.sent) == 3
    assert len([sent for sent in message.sent if sent.text == "Final answer"]) == 1
    children = [sent for sent in message.sent if sent.text.startswith("Delegated to sub-agent")]
    assert len(children) == 2 and all(sent.text.endswith("Completed") for sent in children)
    assert all(any("operation-" in edit for edit in sent.edits) for sent in children)
    await bridge.stop()


@pytest.mark.asyncio
async def test_revocation_prevents_pending_edits_and_final_publication():
    bridge = message = transport = None
    async def produce(emit):
        await emit(BridgeEvent("text", "already accepted"))
        await asyncio.sleep(0)
        transport.allowed = False
        await emit(BridgeEvent("text", "must not leak"))
    bridge, message, transport = fixture(produce)
    await bridge.dispatch_turn(message, "tg:100", "question", context=bridge._bridge_context(message))
    assert all("must not leak" not in sent.text and "Final answer" not in sent.text for sent in message.sent)
    await bridge.stop()


@pytest.mark.asyncio
async def test_explicit_rate_limit_is_retried_but_uncertain_send_never_is():
    from unittest.mock import AsyncMock
    from telegram.error import RetryAfter
    target = object()
    handle = object()
    bridge = SimpleNamespace(turn_edit_interval=0,
        post_turn_message=AsyncMock(side_effect=[RetryAfter(0), handle]),
        update_turn_message=AsyncMock())
    message = EditableMessage(bridge, target)
    await message.finish('final')
    assert message.handle is handle and bridge.post_turn_message.await_count == 2
    bridge.post_turn_message = AsyncMock(side_effect=TimeoutError('unknown acceptance'))
    uncertain = EditableMessage(bridge, target)
    await uncertain.update('progress')
    await uncertain.task
    with pytest.raises(RuntimeError, match='reconciliation'):
        await uncertain.finish('final')
    bridge.post_turn_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_child_remains_failed_after_successful_parent():
    async def produce(emit):
        await emit(BridgeEvent('child', json.dumps(dict(session_id='failed-child', type='error'))))
    bridge, message, _ = fixture(produce)
    await bridge.dispatch_turn(message, 'tg:100', 'question', context=bridge._bridge_context(message))
    children = [sent for sent in message.sent if sent.text.startswith('Delegated to sub-agent')]
    assert len(children) == 1 and children[0].text.endswith('Failed')
    await bridge.stop()
