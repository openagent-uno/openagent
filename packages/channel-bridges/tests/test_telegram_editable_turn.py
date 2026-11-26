import asyncio
from types import SimpleNamespace
import json

import pytest

from openagent_channel_bridges.contracts import BridgeCapabilities, BridgeEvent, BridgePart, BridgeReply
from openagent_channel_bridges.formatting import markdown_to_telegram_html
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
async def test_overlong_rendered_table_preserves_the_complete_saved_reply(monkeypatch):
    answer = "| Left | Right |\n| --- | --- |\n| " + "wide" * 150 + " | short |\n"
    answer += "| a | b |\n" * 20
    assert len(answer) < 4096 < len(markdown_to_telegram_html(answer))

    async def produce(emit):
        await emit(BridgeEvent("text", "Thinking"))
        await asyncio.sleep(0)

    edit = Sent.edit_text
    async def enforce_limit(self, text, **options):
        assert len(text.encode("utf-16-le")) // 2 <= 4096
        assert options["parse_mode"] is None
        await edit(self, text, **options)
    monkeypatch.setattr(Sent, "edit_text", enforce_limit)

    bridge, message, _ = fixture(produce, answer)
    await bridge.dispatch_turn(message, "tg:100", "question", context=bridge._bridge_context(message))
    assert len(message.sent) == 1
    assert message.sent[0].text.strip() == answer.strip()
    await bridge.stop()


@pytest.mark.asyncio
async def test_overlong_unicode_reply_sends_every_chunk_within_the_limit(monkeypatch):
    answer = "🟩" * 2500

    async def produce(emit):
        await emit(BridgeEvent("text", "Thinking"))
        await asyncio.sleep(0)

    reply = Message.reply_text
    edit = Sent.edit_text

    async def enforce_send(self, text, **options):
        assert len(text.encode("utf-16-le")) // 2 <= 4096
        return await reply(self, text, **options)

    async def enforce_edit(self, text, **options):
        assert len(text.encode("utf-16-le")) // 2 <= 4096
        await edit(self, text, **options)

    monkeypatch.setattr(Message, "reply_text", enforce_send)
    monkeypatch.setattr(Sent, "edit_text", enforce_edit)
    bridge, message, _ = fixture(produce, answer)
    await bridge.dispatch_turn(message, "tg:100", "question", context=bridge._bridge_context(message))
    assert len(message.sent) > 1
    assert "".join(sent.text for sent in message.sent) == answer
    await bridge.stop()


@pytest.mark.asyncio
async def test_each_subagent_has_one_separate_message_updated_with_its_own_operation():
    async def produce(emit):
        for child in ("child-one", "child-two"):
            await emit(BridgeEvent("status", json.dumps({"tool_name": "delegate_task_to_member",
                "tool_call_id": child, "child_session_id": child, "tool_args": {"member_id": child}})))
        await asyncio.sleep(0)
        for child in ("child-one", "child-two"):
            await emit(BridgeEvent("child", json.dumps({"session_id": child, "type": "delta",
                "text": f"narration from {child}"})))
            await asyncio.sleep(0)
            for index in range(20):
                await emit(BridgeEvent("child", json.dumps({"session_id": child, "type": "status", "text": f"operation-{child}-{index}"})))
            await asyncio.sleep(0)
            await emit(BridgeEvent("child", json.dumps({"session_id": child, "type": "response",
                "text": f"final from {child}"})))
            await emit(BridgeEvent("child", json.dumps({"session_id": child, "type": "turn_complete", "reason": "completed"})))
    bridge, message, _ = fixture(produce)
    await bridge.dispatch_turn(message, "tg:100", "question", context=bridge._bridge_context(message))
    assert len(message.sent) == 3
    assert len([sent for sent in message.sent if sent.text == "Final answer"]) == 1
    children = [sent for sent in message.sent if sent.text.startswith("Delegated to sub-agent")]
    assert len(children) == 2 and all(sent.text.endswith("Completed") for sent in children)
    assert all(any("operation-" in edit for edit in sent.edits) for sent in children)
    for child, sibling in (("child-one", "child-two"), ("child-two", "child-one")):
        message_for_child = next(sent for sent in children if f"· {child}" in sent.text)
        assert f"final from {child}" in message_for_child.text
        assert any(f"narration from {child}" in edit for edit in message_for_child.edits)
        assert sibling not in message_for_child.text
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


@pytest.mark.asyncio
async def test_retry_after_cools_the_parent_and_children_on_the_same_destination():
    from telegram.error import RetryAfter
    from openagent_channel_bridges.turn_messages import EditableTurn

    limited = asyncio.Event()
    posted = []
    loop = asyncio.get_running_loop()
    retry = 0.05

    async def post(target, text):
        at = loop.time()
        posted.append((text, at))
        if len(posted) == 1:
            limited.set()
            raise RetryAfter(retry)
        return object()

    stub = SimpleNamespace(turn_edit_interval=0, message_limit=4096, post_turn_message=post)
    turn = EditableTurn(stub, object())
    await turn.delta("parent")
    await limited.wait()
    await turn.child("child", "thinking")
    await asyncio.gather(turn.main.task, turn.children["child"].task)
    assert len(posted) == 3
    assert all(at - posted[0][1] >= retry * .9 for _, at in posted[1:])


class _Clock:
    def __init__(self):
        self.now = 0
        self.waiting = []

    def monotonic(self):
        return self.now

    async def sleep(self, delay):
        future = asyncio.get_running_loop().create_future()
        self.waiting.append((self.now + delay, future))
        await future

    def advance(self, value):
        self.now = value
        for deadline, future in self.waiting:
            if deadline <= value and not future.done():
                future.set_result(None)


async def _spin_until(predicate):
    for _ in range(30):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate(), "The expected provider pause was never armed"


@pytest.fixture
def delivery_clock(monkeypatch):
    from openagent_channel_bridges import turn_messages as delivery

    clock = _Clock()
    monkeypatch.setattr(delivery, "time", clock)
    awaits = SimpleNamespace(sleep=clock.sleep, create_task=asyncio.create_task,
        Lock=asyncio.Lock, CancelledError=asyncio.CancelledError, timeout=asyncio.timeout, gather=asyncio.gather)
    monkeypatch.setattr(delivery, "asyncio", awaits)
    return clock


@pytest.mark.asyncio
async def test_54_second_retry_coalesces_parent_and_child_and_delivers_the_final_once(delivery_clock):
    from telegram.error import RetryAfter
    from openagent_channel_bridges import turn_messages as delivery

    clock = delivery_clock
    attempts, accepted = [], []

    async def post(_target, text):
        attempts.append((clock.now, text))
        if len(attempts) == 1:
            raise RetryAfter(54)
        accepted.append(text)
        return object()

    stub = SimpleNamespace(turn_edit_interval=0, turn_retry_budget=90, message_limit=4096,
        post_turn_message=post, split_text=lambda text: [text])
    turn = delivery.EditableTurn(stub, object())
    await turn.delta("Initial draft")
    await _spin_until(lambda: bool(clock.waiting))
    await turn.delta("Intermediate draft")
    await turn.child("child", "Reading")
    await turn.child_frame({"session_id": "child", "type": "delta", "text": "Child working"})
    await turn.child_frame({"session_id": "child", "type": "response", "text": "Child result"})
    await turn.child_frame({"session_id": "child", "type": "turn_complete"})
    finish = asyncio.create_task(turn.finish("Final parent reply"))
    await asyncio.sleep(0)
    await turn.delta("Late detached delta")
    await turn.child_frame({"session_id": "late", "type": "delta", "text": "Late child"})
    clock.advance(53)
    await asyncio.sleep(0)
    assert attempts == [(0, "Initial draft")] and not finish.done()
    clock.advance(54)
    await asyncio.wait_for(finish, 1)
    assert accepted.count("Final parent reply") == 1
    assert accepted.count("Delegated to sub-agent\n\nChild result\n\nCompleted") == 1
    assert len(accepted) == 2
    assert all(at == 54 for at, _ in attempts[1:])


@pytest.mark.asyncio
async def test_over_budget_cooldown_blocks_new_turns_only_in_the_same_telegram_chat(delivery_clock):
    from dataclasses import replace
    from telegram.error import RetryAfter
    from openagent_channel_bridges import turn_messages as delivery
    from openagent_channel_bridges.base import _active_context

    clock = delivery_clock
    telegram, target, _ = fixture(lambda _: None)
    context = telegram._bridge_context(target)
    token = _active_context.set(context)
    try:
        same = telegram.editable_turn_cooldown()
        assert telegram.editable_turn_cooldown() is same
    finally:
        _active_context.reset(token)
    token = _active_context.set(replace(context, conversation_id="200"))
    try:
        separate = telegram.editable_turn_cooldown()
    finally:
        _active_context.reset(token)
    assert separate is not same

    attempts = []

    async def post(destination, text):
        attempts.append((destination, clock.now, text))
        if len(attempts) == 1:
            raise RetryAfter(120)
        return object()

    stub = SimpleNamespace(turn_edit_interval=0, turn_retry_budget=90, message_limit=4096,
        post_turn_message=post, split_text=lambda text: [text], editable_turn_cooldown=lambda: same)
    blocked = delivery.EditableTurn(stub, "same")
    await blocked.delta("Rejected preview")
    await blocked.main.task
    for index in range(20):
        await blocked.delta(f"Deferred preview {index}")
    with pytest.raises(delivery.EditableDeliveryDeferred):
        await blocked.finish("Blocked final")
    with pytest.raises(delivery.EditableDeliveryDeferred):
        await delivery.EditableTurn(stub, "same").finish("Still blocked")

    stub.editable_turn_cooldown = lambda: separate
    await delivery.EditableTurn(stub, "separate").finish("Different chat")
    stub.editable_turn_cooldown = lambda: same
    clock.advance(120)
    await delivery.EditableTurn(stub, "same").finish("Accepted after cooldown")
    assert attempts == [("same", 0, "Rejected preview"), ("separate", 0, "Different chat"),
                        ("same", 120, "Accepted after cooldown")]


@pytest.mark.asyncio
async def test_total_delivery_budget_does_not_stack_provider_cooldowns(delivery_clock):
    from telegram.error import RetryAfter
    from openagent_channel_bridges import turn_messages as delivery

    clock = delivery_clock
    attempts = []

    async def post(_destination, text):
        attempts.append((clock.now, text))
        raise RetryAfter(54)

    stub = SimpleNamespace(turn_edit_interval=0, turn_retry_budget=90, message_limit=4096,
                           post_turn_message=post, split_text=lambda text: [text])
    turn = delivery.EditableTurn(stub, object())
    finish = asyncio.create_task(turn.finish("Final answer"))
    await _spin_until(lambda: bool(clock.waiting))
    clock.advance(54)
    with pytest.raises(delivery.EditableDeliveryDeferred):
        await asyncio.wait_for(finish, 1)
    assert attempts == [(0, "Final answer"), (54, "Final answer")]
    assert turn.gate.cooldown.ready_at == 108


@pytest.mark.asyncio
async def test_cancellation_stops_pending_parent_and_child_deliveries(delivery_clock):
    from telegram.error import RetryAfter
    from openagent_channel_bridges import turn_messages as delivery

    clock = delivery_clock
    attempts = []

    async def post(_destination, text):
        attempts.append(text)
        raise RetryAfter(54)

    stub = SimpleNamespace(turn_edit_interval=0, turn_retry_budget=90, message_limit=4096,
                           post_turn_message=post, split_text=lambda text: [text])
    turn = delivery.EditableTurn(stub, object())
    await turn.delta("Limited preview")
    await _spin_until(lambda: bool(clock.waiting))
    await turn.child("child", "Child pending")
    finish = asyncio.create_task(turn.finish("Cancelled reply"))
    await asyncio.sleep(0)
    finish.cancel()
    with pytest.raises(asyncio.CancelledError):
        await finish
    clock.advance(54)
    await asyncio.sleep(0)
    assert attempts == ["Limited preview"]
    assert all(item.closed and item.task.done() for item in (turn.main, turn.children["child"]))


@pytest.mark.asyncio
async def test_provider_cooldown_also_suspends_typing_for_that_telegram_chat(delivery_clock):
    from telegram.error import RetryAfter
    from openagent_channel_bridges.telegram import _TypingAnimator
    from openagent_channel_bridges.turn_messages import DeliveryCooldown

    clock = delivery_clock
    pulses = []

    async def typing(chat, _action):
        pulses.append(chat)

    cooldown = DeliveryCooldown()
    cooldown.observe(RetryAfter(54))
    animator = _TypingAnimator(SimpleNamespace(send_chat_action=typing), 100, cooldown)
    await animator._pulse("initial")
    clock.advance(54)
    await animator._pulse("keepalive")
    assert pulses == [100]
