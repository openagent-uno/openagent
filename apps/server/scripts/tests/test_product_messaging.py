from __future__ import annotations

import pytest


def _names(toolkit) -> set[str]:
    return set(toolkit.functions) | set(toolkit.async_functions)


def test_product_resolver_owns_messaging_and_preserves_environment() -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    resolved = standalone_spec_resolver(
        {}, environment={"TELEGRAM_BOT_TOKEN": "test-token"}
    )({"name": "messaging"}, "/tmp/openagent.db")

    assert resolved["in_process"] is True
    assert resolved["adapter_module"] == "openagent_server.messaging_tools.adapters"
    assert resolved["env"]["TELEGRAM_BOT_TOKEN"] == "test-token"


def test_messaging_toolkit_is_scoped_to_configured_channels() -> None:
    from openagent_server.messaging_tools.adapters import build_runtime_toolkit

    disabled = _names(build_runtime_toolkit(env={}))
    telegram = _names(build_runtime_toolkit(env={"TELEGRAM_BOT_TOKEN": "test-token"}))

    assert disabled == {"messaging_status"}
    assert telegram == {
        "messaging_status", "telegram_send_message", "telegram_send_file",
    }


@pytest.mark.asyncio
async def test_telegram_tool_uses_product_credential(monkeypatch) -> None:
    from openagent_server.messaging_tools import adapters

    calls = []

    async def capture(url, **kwargs):
        calls.append((url, kwargs))
        return {"ok": True}

    monkeypatch.setattr(adapters, "_json_post", capture)
    toolkit = adapters.build_runtime_toolkit(env={"TELEGRAM_BOT_TOKEN": "host-token"})
    result = await toolkit.async_functions["telegram_send_message"].entrypoint(
        chat_id="42", text="hello"
    )

    assert result == {"ok": True}
    assert calls == [(
        "https://api.telegram.org/bothost-token/sendMessage",
        {"json": {"chat_id": "42", "text": "hello"}},
    )]
