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
    return BridgeContext("binding", "slack", "team", "alice", "channel", "event", "thread")


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
