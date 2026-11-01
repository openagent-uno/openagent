"""Bridges inherit Core's chat commands and report their real outcome."""
import asyncio
import json
import types

import pytest
from openagent_core.chat_commands import COMMAND_SPECS, commands_for_scopes

from openagent_channel_bridges import commands, stdio, wire
from openagent_channel_bridges.contracts import (BridgeCapabilities, BridgeCommandDefinition, BridgeCommandResult,
                                                 BridgePart)
from openagent_channel_bridges.telegram import TelegramBridge


def test_bridge_catalogue_is_core_catalogue():
    assert commands.COMMAND_SPECS is COMMAND_SPECS
    assert commands.BRIDGE_COMMANDS == tuple(spec.name for spec in COMMAND_SPECS)


def test_capability_inherits_core_scope_without_listing_commands():
    capabilities = wire.capabilities({"commands": [], "core_commands": ["session"]})
    names = [item.name for item in capabilities.commands]
    assert names == [spec.name for spec in commands_for_scopes(["session"])]
    assert "new" in names and "restart" not in names
    # No confirmation requirement: only Telegram has a confirmation surface.
    assert not any(item.confirmation_required for item in capabilities.commands)


def test_explicit_host_definition_wins_and_is_not_duplicated():
    own = BridgeCommandDefinition("new", "Host wording", True)
    capabilities = BridgeCapabilities(commands=(own,), core_commands=("session",))
    assert [item for item in capabilities.commands if item.name == "new"] == [own]


@pytest.mark.parametrize("value", [{"core_commands": ["everything"]}, {"core_commands": "session"}, {"core_commands": [1]}])
def test_invalid_core_scope_fails_closed(value):
    with pytest.raises(wire.WireError):
        wire.capabilities(value)


def test_describe_lets_a_host_detect_inheritance_before_declaring_it():
    assert stdio.describe()["core_commands"] == ["instance", "session"]


def test_picker_with_core_auto_option_crosses_the_wire():
    result = wire.result_dto("command", {"status": "completed", "parts": [], "picker_command": "model", "picker_prompt": "Pick",
        "options": [{"value": "default", "label": "Auto", "subtitle": None, "active": True}]}, None, "child-1")
    assert result.options[0].label == "Auto"


class Host:
    def __init__(self, capabilities, outcome=None, error=None):
        self.capabilities, self.outcome, self.error, self.calls = capabilities, outcome, error, []

    async def start(self):
        return self.capabilities

    async def stop(self):
        pass

    async def authorize_context(self, context):
        return True

    async def authorize_delivery(self, context):
        return True

    async def command(self, request):
        self.calls.append(request)
        if self.error is not None:
            raise self.error
        return self.outcome


async def _noop(*args, **kwargs):
    return types.SimpleNamespace(id=1, message_id=99, chat_id=111)


BOT = types.SimpleNamespace(id=4242, username="bot", send_message=_noop, send_chat_action=_noop, get_me=_noop)


async def _get_chat(chat_id):
    return types.SimpleNamespace(id=chat_id, type="private")
BOT.get_chat = _get_chat


class Message:
    def __init__(self):
        self.message_id, self.text, self.caption, self.chat_id = 3, "/new", None, 111
        self.from_user = types.SimpleNamespace(id=111)
        self.chat = types.SimpleNamespace(id=111, type="private")
        self.message_thread_id = self.reply_to_message = None
        self.replies, self.markups = [], []

    def get_bot(self):
        return BOT

    async def reply_text(self, text, **kwargs):
        self.replies.append(text)
        self.markups.append(kwargs.get("reply_markup"))


class Callback:
    id, data = "9001", "confirm_cmd:new"

    def __init__(self, message):
        self.message, self.from_user, self.edits = message, message.from_user, []

    async def answer(self, *args, **kwargs):
        pass

    async def edit_message_text(self, text, **kwargs):
        self.edits.append(text)


def telegram(host):
    bridge = TelegramBridge("000:synthetic", allowed_users=["111"], transport=host, binding_id="binding-1")
    bridge._context_bot = BOT
    return bridge


def update(**kwargs):
    update.serial += 1
    return types.SimpleNamespace(update_id=update.serial, **kwargs)
update.serial = 100


def confirm(bridge):
    pytest.importorskip("telegram")
    message = Message()
    context = types.SimpleNamespace(args=[], bot=BOT)

    async def flow():
        await bridge._on_command(update(message=message), context, "new")
        callback = Callback(message)
        if any(markup is not None for markup in message.markups):
            await bridge._on_callback(update(callback_query=callback), context)
        return message, callback
    return asyncio.run(flow())


AVAILABLE = BridgeCapabilities(core_commands=("session",))


def test_unavailable_reset_never_asks_for_confirmation():
    host = Host(BridgeCapabilities())
    message, callback = confirm(telegram(host))
    assert message.replies == ["/new non è disponibile su questo agente: la conversazione non è stata azzerata."]
    assert host.calls == [] and callback.edits == []


def test_confirmation_is_truthful_and_done_is_only_for_completed():
    host = Host(AVAILABLE, BridgeCommandResult(status="completed", parts=(BridgePart(text="Fresh."),)))
    message, callback = confirm(telegram(host))
    assert "Cancellerà" not in message.replies[0] and "memoria a lungo termine" in message.replies[0]
    assert callback.edits == ["✅ Fatto: `/new`. Fresh."]
    assert host.calls[0].confirmed is True


@pytest.mark.parametrize("status", ["failed", "unsupported"])
def test_unfinished_command_is_not_called_done(status):
    _message, callback = confirm(telegram(Host(AVAILABLE, BridgeCommandResult(status=status))))
    assert "Fatto" not in callback.edits[0] and "non eseguito" in callback.edits[0]
    assert "could not be completed" in callback.edits[0]


def test_transport_error_is_not_called_done():
    _message, callback = confirm(telegram(Host(AVAILABLE, error=ConnectionError("host"))))
    assert "Fatto" not in callback.edits[0] and "non eseguito" in callback.edits[0]
