from datetime import datetime, timedelta, timezone
import io
import json
from unittest.mock import AsyncMock, patch

import click
from click.testing import CliRunner
import pytest
from rich.console import Console

from openagent_cli.connectors import authorize, connect, register


def commands(client):
    @click.group()
    def cli():
        pass
    opened, closed = AsyncMock(return_value=(client, None)), AsyncMock()
    register(cli, opened, closed, Console())
    return cli, opened, closed


def test_catalog_uses_authenticated_server_and_preserves_unavailable_entries():
    client = AsyncMock()
    client.rest_get.return_value = {"available": True, "connectors": [
        {"id": "gmail", "name": "Gmail", "available": False, "unavailableReason": "Authorization not enabled"},
        {"id": "replio", "name": "Replio", "available": True},
    ]}
    cli, opened, closed = commands(client)
    result = CliRunner().invoke(cli, ["marketplace", "official", "--network", "work", "--agent", "friday", "--handle", "owner", "--json"])
    assert result.exit_code == 0, result.output
    assert len(json.loads(result.output)["connectors"]) == 2
    opened.assert_awaited_once_with("work", None, "friday", principal_handle="owner", quiet=True)
    client.rest_get.assert_awaited_once_with("/api/marketplace/official")
    closed.assert_awaited_once_with(client)


def test_failed_operation_disconnects_and_does_not_expose_transport_body():
    client = AsyncMock()
    client.rest_delete.side_effect = RuntimeError("private-token-from-response")
    cli, _, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "disconnect", "conn/other"])
    assert result.exit_code != 0
    assert "private-token" not in result.output
    client.rest_delete.assert_awaited_once_with("/api/connectors/conn%2Fother")
    closed.assert_awaited_once_with(client)


def test_configuration_changes_only_explicit_settings_on_authenticated_server():
    client = AsyncMock()
    cli, opened, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "configure", "conn/one", "--read-only", "--json"])
    assert result.exit_code == 0, result.output
    client.rest_put.assert_awaited_once_with("/api/connectors/conn%2Fone", {"allow_write": False})
    assert json.loads(result.output) == {"ok": True}
    opened.assert_awaited_once()
    closed.assert_awaited_once_with(client)


def test_configuration_requires_explicit_choice_before_connecting():
    client = AsyncMock()
    cli, opened, _ = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "configure", "conn"])
    assert result.exit_code != 0
    opened.assert_not_awaited()


@pytest.mark.asyncio
async def test_unavailable_connector_never_prompts_or_creates():
    client = AsyncMock()
    client.rest_get.return_value = {"connectors": [{"id": "shopify", "available": False, "unavailableReason": "Privacy processing pending"}]}
    with patch("openagent_cli.connectors.Prompt.ask") as prompt:
        with pytest.raises(click.ClickException, match="Privacy"):
            await connect(client, "shopify", False, Console())
        prompt.assert_not_called()
    client.rest_post.assert_not_called()


@pytest.mark.asyncio
async def test_token_sent_only_to_authenticated_server_and_cleared():
    client = AsyncMock()
    client.rest_get.return_value = {"connectors": [{"id": "replio", "auth": "token", "available": True}]}
    client.rest_post.return_value = {"connection": {"id": "conn"}}
    seen = []
    async def post(path, payload):
        assert path == "/api/connectors"
        assert payload["token"] == "private-replio-token"
        assert payload["allow_write"] is False
        seen.append(payload)
        return {"connection": {"id": "conn", "status": "connected"}}
    client.rest_post.side_effect = post
    output = io.StringIO()
    with patch("openagent_cli.connectors.Prompt.ask", side_effect=["private-replio-token", "org"]):
        await connect(client, "replio", False, Console(file=output))
    assert "token" not in seen[0]
    assert "private-replio-token" not in output.getvalue()


@pytest.mark.asyncio
async def test_authorization_rejects_other_receiver_before_browser_or_poll():
    client = AsyncMock()
    with patch("openagent_cli.connectors.webbrowser.open") as browser:
        with pytest.raises(click.ClickException, match="invalid"):
            await authorize(client, {"authorization_url": "https://evil.example/authorize/" + "a" * 43}, Console())
        browser.assert_not_called()
    client.rest_post.assert_not_called()


@pytest.mark.asyncio
async def test_missing_completed_connection_is_not_reported_as_success():
    output = io.StringIO()
    with pytest.raises(click.ClickException, match="did not complete"):
        await authorize(AsyncMock(), {"error": "not_authorized"}, Console(file=output))
    assert "Connected" not in output.getvalue()


@pytest.mark.asyncio
async def test_authorization_polls_exact_connection_until_connected():
    client = AsyncMock()
    client.rest_post.side_effect = [{"status": "pending"}, {"status": "connected"}]
    setup = {"authorization_url": "https://auth.openagent.uno/authorize/" + "a" * 43,
             "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(), "connection": {"id": "conn"}}
    with patch("openagent_cli.connectors.webbrowser.open") as browser, patch("openagent_cli.connectors.asyncio.sleep", new_callable=AsyncMock):
        await authorize(client, setup, Console(file=io.StringIO()))
        browser.assert_called_once_with(setup["authorization_url"])
    assert client.rest_post.await_count == 2
    assert all(call.args == ("/api/connectors/conn/poll", {}) for call in client.rest_post.await_args_list)
