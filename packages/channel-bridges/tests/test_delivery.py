from dataclasses import replace
import asyncio

import pytest

from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import (
    BridgeAttachment, BridgeCapabilities, BridgeCommandDefinition,
    BridgeCommandResult, BridgeContext, BridgePart, BridgePickerOption, BridgeReply,
)


class Transport:
    def __init__(self, reply=None):
        self.reply = reply or BridgeReply((BridgePart(text="answer"),))
        self.allowed = True
        self.events = []
        self.commands = []
        self.starts = self.stops = 0

    async def authorize_context(self, context):
        self.events.append(("authorize", context.actor_id))
        return self.allowed and context.actor_id == "alice" and context.binding_id == "binding"

    async def start(self):
        self.starts += 1
        return BridgeCapabilities(
            commands=(BridgeCommandDefinition("model", "Model"),
                      BridgeCommandDefinition("reset", "Reset", confirmation_required=True)),
            output_media=("file",),
        )

    async def stop(self):
        self.stops += 1

    async def send(self, request, *, on_event=None):
        self.events.append(("send", request.context.actor_id))
        return self.reply

    async def command(self, request):
        self.commands.append(request)
        return BridgeCommandResult(
            options=(BridgePickerOption("opaque", "Model A", active=True),),
            picker_command="model", picker_prompt="Choose",
        )


class CaptureBridge(BaseBridge):
    name = "slack"
    def __init__(self, transport):
        super().__init__(transport=transport, live=False)
        self.sent = []
        self.revoke_after_first = False

    async def _run(self):
        return

    async def send_text_chunk(self, target, chunk):
        self.sent.append(("text", target, chunk))
        if self.revoke_after_first:
            self.transport.allowed = False

    async def send_attachment(self, target, attachment):
        self.sent.append(("file", target, attachment.filename))


def context():
    return BridgeContext("binding", "slack", "team", "alice", "channel", "event", "thread",
                         conversation_kind="direct", audience_ids=("alice",), audience_complete=True)


@pytest.mark.asyncio
async def test_typed_reply_retains_text_media_order_and_only_cleans_owned_artifacts(tmp_path):
    unowned = tmp_path / "keep.txt"; unowned.write_text("keep")
    owned = tmp_path / "temporary.txt"; owned.write_text("temporary")
    parts = (BridgePart(text="before"),
             BridgePart(attachment=BridgeAttachment("file", "keep.txt", local_path=str(unowned))),
             BridgePart(text="between"),
             BridgePart(attachment=BridgeAttachment("file", "temporary.txt", local_path=str(owned), owned=True)),
             BridgePart(text="after"))
    bridge = CaptureBridge(Transport(BridgeReply(parts)))
    target = {"channel": "channel", "thread_ts": "thread"}
    await bridge.dispatch_turn(target, "hint", "question", context=context())
    assert [(event[0], event[2]) for event in bridge.sent] == [
        ("text", "before"), ("file", "keep.txt"), ("text", "between"),
        ("file", "temporary.txt"), ("text", "after"),
    ]
    assert all(event[1] is target for event in bridge.sent)
    assert unowned.read_text() == "keep" and not owned.exists()
    await bridge.stop()


@pytest.mark.asyncio
async def test_revoked_actor_cannot_receive_later_text_or_media(tmp_path):
    file = tmp_path / "private.txt"; file.write_text("private")
    parts = (BridgePart(text="first"), BridgePart(text="must not publish"),
             BridgePart(attachment=BridgeAttachment("file", "private.txt", local_path=str(file))))
    transport = Transport(BridgeReply(parts)); bridge = CaptureBridge(transport)
    bridge.revoke_after_first = True
    with pytest.raises(PermissionError):
        await bridge.dispatch_turn("target", "hint", "question", context=context())
    assert bridge.sent == [("text", "target", "first")]
    assert file.exists()
    await bridge.stop()


@pytest.mark.asyncio
async def test_commands_supported_confirmed_and_original_actor_context():
    transport = Transport(); bridge = CaptureBridge(transport)
    result = await bridge.send_command_full("model", "hint", context=context())
    assert result["picker"] == {"command": "model", "prompt": "Choose", "options": [
        {"value": "opaque", "label": "Model A", "subtitle": None, "active": True}]}
    assert transport.commands[0].context.actor_id == "alice"
    assert (await bridge.send_command_full("update", "hint", context=context()))["status"] == "unsupported"
    assert (await bridge.send_command_full("reset", "hint", context=context()))["status"] == "confirmation_required"
    assert len(transport.commands) == 1
    with pytest.raises(PermissionError):
        await bridge.send_command_full("model", "hint", context=replace(context(), actor_id="mallory"))
    await bridge.stop(); await bridge.stop()
    assert transport.starts == 1 and transport.stops == 1


@pytest.mark.asyncio
async def test_transport_failure_does_not_publish_secret_details():
    transport = Transport()
    async def fail(*args, **kwargs):
        raise RuntimeError("secret=DO_NOT_PUBLISH /private/host/file")
    transport.send = fail
    bridge = CaptureBridge(transport)
    await bridge.dispatch_turn("target", "hint", "question", context=context())
    text = str(bridge.sent)
    assert "DO_NOT_PUBLISH" not in text and "/private/host" not in text
    assert bridge.sent
    await bridge.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["send", "command"])
@pytest.mark.parametrize("interruption", ["revoke", "stop"])
async def test_revocation_or_stop_during_start_cannot_dispatch_later(operation, interruption):
    transport = Transport()
    started, release = asyncio.Event(), asyncio.Event()
    original_start = transport.start
    async def held_start():
        started.set()
        await release.wait()
        return await original_start()
    transport.start = held_start
    bridge = CaptureBridge(transport)
    task = asyncio.create_task(
        bridge.send_message("question", "hint", context=context()) if operation == "send" else
        bridge.send_command_full("model", "hint", context=context()))
    await asyncio.wait_for(started.wait(), 1)
    stop = None
    if interruption == "stop":
        stop = asyncio.create_task(bridge.stop())
        await asyncio.sleep(0)
    else:
        transport.allowed = False
    release.set()
    with pytest.raises(PermissionError):
        await asyncio.wait_for(task, 1)
    if stop:
        await asyncio.wait_for(stop, 1)
    assert not transport.commands
    assert not [event for event in transport.events if event[0] == "send"]
    await bridge.stop()


class AudienceTransport(Transport):
    def __init__(self, approval=True):
        super().__init__()
        self.approval = approval
        self.delivery_contexts = []
        self.requests = []

    async def authorize_delivery(self, context):
        self.delivery_contexts.append(context)
        return self.approval

    async def send(self, request, *, on_event=None):
        self.requests.append(request)
        return await super().send(request, on_event=on_event)

    async def command(self, request):
        self.requests.append(request)
        return await super().command(request)


async def _invoke_bridge(bridge, operation, current):
    if operation == "send":
        return await bridge.send_message("question", "hint", context=current)
    return await bridge.send_command_full("model", "hint", context=current)


def _assert_no_runtime_invocation(transport):
    assert not transport.commands
    assert not [event for event in transport.events if event[0] == "send"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["send", "command"])
@pytest.mark.parametrize("audience", [(), ("alice",)])
async def test_group_missing_or_incomplete_audience_never_reaches_runtime(operation, audience):
    transport = AudienceTransport()
    bridge = CaptureBridge(transport)
    current = replace(context(), conversation_kind="group", audience_ids=audience,
                      audience_complete=False, audience_verified_at=None)
    with pytest.raises(PermissionError):
        await _invoke_bridge(bridge, operation, current)
    _assert_no_runtime_invocation(transport)
    assert not transport.delivery_contexts
    await bridge.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["send", "command"])
@pytest.mark.parametrize("kind", ["group", "unknown"])
async def test_non_direct_context_requires_explicit_host_delivery_policy(operation, kind):
    transport = Transport()  # The old actor-only transport is compatible only for direct delivery.
    bridge = CaptureBridge(transport)
    with pytest.raises(PermissionError):
        await _invoke_bridge(bridge, operation, replace(context(), conversation_kind=kind))
    _assert_no_runtime_invocation(transport)
    await bridge.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["send", "command"])
@pytest.mark.parametrize("approval", [False, None, 1, "true"])
async def test_pre_rpc_delivery_denial_requires_literal_true_and_never_invokes_runtime(operation, approval):
    transport = AudienceTransport(approval)
    bridge = CaptureBridge(transport)
    with pytest.raises(PermissionError):
        await _invoke_bridge(bridge, operation, replace(context(), conversation_kind="group"))
    assert len(transport.delivery_contexts) == 1
    _assert_no_runtime_invocation(transport)
    await bridge.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [
    ("binding_id", "other-binding"), ("provider", "discord"), ("account_id", "other-team"),
    ("actor_id", "mallory"), ("conversation_id", "other-channel"), ("event_id", "other-event"),
    ("thread_id", "other-thread"), ("reply_to_event_id", "other-reply"),
    ("conversation_kind", "direct"),
])
async def test_provider_audience_hook_cannot_change_identity_or_downgrade_group(field, value):
    transport = AudienceTransport()
    bridge = CaptureBridge(transport)
    async def changed(current):
        return replace(current, **{field: value})
    bridge._delivery_context = changed
    with pytest.raises(PermissionError):
        await bridge.send_message("question", "hint", context=replace(context(), conversation_kind="group"))
    _assert_no_runtime_invocation(transport)
    assert not transport.delivery_contexts
    await bridge.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["send", "command"])
async def test_actor_admission_precedes_membership_read_and_runtime_receives_fresh_attestation(operation):
    transport = AudienceTransport()
    bridge = CaptureBridge(transport)
    refreshed = []
    async def fresh(current):
        assert transport.events[-1] == ("authorize", "alice")
        refreshed.append(current)
        return replace(current, audience_ids=("alice", "bob"), audience_complete=True,
                       audience_verified_at=12345.0)
    bridge._delivery_context = fresh
    original = replace(context(), conversation_kind="group", audience_ids=(), audience_complete=False)
    await _invoke_bridge(bridge, operation, original)
    delivered = transport.requests[0].context
    assert delivered.audience_ids == ("alice", "bob")
    assert delivered.audience_complete is True and delivered.audience_verified_at == 12345.0
    assert delivered.conversation_kind == "group" and delivered.actor_id == original.actor_id
    assert transport.delivery_contexts[0] == delivered
    assert refreshed
    await bridge.stop()


@pytest.mark.asyncio
async def test_non_boolean_actor_admission_cannot_trigger_membership_or_runtime():
    transport = AudienceTransport()
    async def non_boolean(_context):
        return 1
    transport.authorize_context = non_boolean
    bridge = CaptureBridge(transport)
    async def forbidden_membership(_context):
        raise AssertionError("membership must follow successful actor admission")
    bridge._delivery_context = forbidden_membership
    with pytest.raises(PermissionError):
        await bridge.send_message("question", "hint", context=replace(context(), conversation_kind="group"))
    _assert_no_runtime_invocation(transport)
    assert not transport.delivery_contexts
    await bridge.stop()

@pytest.mark.asyncio
@pytest.mark.parametrize('code',['provider_not_configured','model_not_configured','auth_expired','quota_exhausted','rate_limit'])
async def test_native_ai_error_reaches_channel_with_an_actionable_remedy(code):
    from openagent_core.core.public_errors import PUBLIC_MESSAGES
    transport=Transport(BridgeReply((BridgePart(text=PUBLIC_MESSAGES[code]),),status='failed'))
    bridge=CaptureBridge(transport)
    await bridge.dispatch_turn('target','hint','question',context=context())
    delivered=' '.join(row[2] for row in bridge.sent if row[0]=='text')
    assert PUBLIC_MESSAGES[code] in delivered
    assert '/clear' not in delivered

@pytest.mark.asyncio
async def test_arbitrary_provider_error_is_not_disclosed_in_native_channel():
    transport=Transport(BridgeReply((BridgePart(text='PRIVATE-KEY provider JSON'),),status='failed'))
    bridge=CaptureBridge(transport)
    await bridge.dispatch_turn('target','hint','question',context=context())
    assert bridge.sent and 'PRIVATE' not in str(bridge.sent)
