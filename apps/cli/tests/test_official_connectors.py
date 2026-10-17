from datetime import datetime, timedelta, timezone
import io
import json
from unittest.mock import AsyncMock, patch

import click
from click.testing import CliRunner
import pytest
from rich.console import Console

from openagent_cli.connectors import authorize, choose_site, connect, register


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


def test_refresh_uses_authenticated_product_route_without_token_output():
    client = AsyncMock()
    client.rest_post.return_value = {"status": "connected", "unexpected": "do-not-display-response"}
    cli, opened, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "refresh", "conn/one", "--network", "work",
                                    "--agent", "agent", "--handle", "owner", "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == {"ok": True}
    assert "do-not-display-response" not in result.output
    opened.assert_awaited_once_with("work", None, "agent", principal_handle="owner", quiet=True)
    client.rest_post.assert_awaited_once_with("/api/connectors/conn%2Fone/refresh", {})
    closed.assert_awaited_once_with(client)


def test_failed_refresh_disconnects_transport_and_sanitizes_error():
    client = AsyncMock()
    client.rest_post.side_effect = RuntimeError("private-refresh-token-from-broker")
    cli, _, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "refresh", "conn"])
    assert result.exit_code != 0
    assert "private-refresh-token" not in result.output
    assert "renewed" not in result.output
    closed.assert_awaited_once_with(client)


def test_site_commands_use_owner_product_routes_and_explicit_target():
    client = AsyncMock()
    cloud_id = "1324a887-45db-1bf4-1e99-ef0ff456d421"
    client.rest_get.return_value = {"sites": [{"id": cloud_id, "name": "QA Jira", "url": "https://qa.atlassian.net", "scopes": ["read:jira-work"]}], "selected_cloud_id": None}
    cli, opened, closed = commands(client)
    listed = CliRunner().invoke(cli, ["connectors", "sites", "conn/one", "--json"])
    assert listed.exit_code == 0 and json.loads(listed.output)["selected_cloud_id"] is None
    client.rest_get.assert_awaited_once_with("/api/connectors/conn%2Fone/sites")
    selected = CliRunner().invoke(cli, ["connectors", "select-site", "conn/one", cloud_id, "--json"])
    assert selected.exit_code == 0 and json.loads(selected.output) == {"ok": True}
    client.rest_put.assert_awaited_once_with("/api/connectors/conn%2Fone/site", {"cloud_id": cloud_id})
    assert opened.await_count == closed.await_count == 2


@pytest.mark.asyncio
async def test_interactive_atlassian_selection_uses_only_returned_site_id():
    client = AsyncMock()
    first = "1324a887-45db-1bf4-1e99-ef0ff456d421"
    second = "2324a887-45db-1bf4-1e99-ef0ff456d421"
    client.rest_get.return_value = {"sites": [{"id": value, "name": "[red]Literal name", "url": "https://qa.atlassian.net"}
                                            for value in (first, second)]}
    with patch("openagent_cli.connectors.Prompt.ask", return_value="2"):
        await choose_site(client, "conn/one", Console(file=io.StringIO()))
    client.rest_put.assert_awaited_once_with("/api/connectors/conn%2Fone/site", {"cloud_id": second})


@pytest.mark.asyncio
async def test_interactive_atlassian_no_sites_never_selects_an_arbitrary_target():
    client = AsyncMock()
    client.rest_get.return_value = {"sites": [], "selected_cloud_id": None}
    with pytest.raises(click.ClickException, match="no Jira site"):
        await choose_site(client, "conn", Console(file=io.StringIO()))
    client.rest_put.assert_not_awaited()


@pytest.mark.asyncio
async def test_atlassian_connect_selects_site_only_after_completed_authorization():
    client = AsyncMock()
    cloud_id = "1324a887-45db-1bf4-1e99-ef0ff456d421"
    client.rest_get.side_effect = [
        {"connectors": [{"id": "atlassian", "auth": "oauth", "available": True}]},
        {"sites": [{"id": cloud_id, "name": "QA Jira", "url": "https://qa.atlassian.net"}]}]
    setup = {"connection": {"id": "conn", "catalog_id": "atlassian"}}
    client.rest_post.return_value = setup
    authorized = AsyncMock()
    with patch("openagent_cli.connectors.authorize", authorized), patch("openagent_cli.connectors.Prompt.ask", return_value="1"):
        await connect(client, "atlassian", False, Console(file=io.StringIO()))
    authorized.assert_awaited_once()
    client.rest_post.assert_awaited_once_with("/api/connectors", {"catalog_id": "atlassian", "allow_write": False, "config": {}})
    assert client.rest_get.await_args_list[-1].args == ("/api/connectors/conn/sites",)
    client.rest_put.assert_awaited_once_with("/api/connectors/conn/site", {"cloud_id": cloud_id})


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
@pytest.mark.parametrize("catalog_id,provider", [("exa", "exa"), ("firecrawl", "firecrawl"),
    ("parallel-search", "parallel_search"), ("context7", "context7"), ("coingecko", "coingecko")])
async def test_keyless_connection_never_prompts_for_credentials_or_opens_oauth(catalog_id, provider):
    client = AsyncMock()
    client.rest_get.return_value = {"connectors": [{"id": catalog_id, "provider": provider,
        "capability": "files", "auth": "none", "available": True}]}
    client.rest_post.return_value = {"connection": {"id": "conn", "status": "connected"}}
    with patch("openagent_cli.connectors.Prompt.ask") as prompt, patch("openagent_cli.connectors.webbrowser.open") as browser:
        await connect(client, catalog_id, False, Console(file=io.StringIO()))
        prompt.assert_not_called()
        browser.assert_not_called()
    client.rest_post.assert_awaited_once_with("/api/connectors", {
        "catalog_id": catalog_id, "allow_write": False, "config": {}})


@pytest.mark.asyncio
@pytest.mark.parametrize("item", [
    {"id": "replio", "provider": "replio", "capability": "outreach", "auth": "none"},
    {"id": "exa", "provider": "other", "capability": "files", "auth": "none"},
    {"id": "parallel-search", "provider": "parallel-search", "capability": "files", "auth": "none"},
    {"id": "context7", "provider": "parallel_search", "capability": "files", "auth": "none"},
    {"id": "exa", "provider": "exa", "capability": "outreach", "auth": "none"},
    {"id": "exa", "provider": "exa", "capability": "files", "auth": "unknown"},
])
async def test_unreviewed_keyless_catalog_cannot_create_or_request_a_token(item):
    client = AsyncMock()
    client.rest_get.return_value = {"connectors": [{**item, "available": True}]}
    with patch("openagent_cli.connectors.Prompt.ask") as prompt:
        with pytest.raises(click.ClickException, match="Unsupported"):
            await connect(client, item["id"], False, Console(file=io.StringIO()))
        prompt.assert_not_called()
    client.rest_post.assert_not_awaited()


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


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", [
    "https://accounts.google.com", "https://app.clickup.com", "https://platform.postiz.com",
    "https://github.com", "https://api.notion.com", "https://slack.com", "https://auth.atlassian.com",
])
async def test_own_app_authorization_accepts_exact_reviewed_origins(origin):
    client = AsyncMock()
    client.rest_post.return_value = {"status": "connected"}
    setup = {"authorization_mode": "own-app", "authorization_url": origin + "/oauth/authorize?state=opaque",
             "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(), "connection": {"id": "conn"}}
    with patch("openagent_cli.connectors.webbrowser.open") as browser:
        await authorize(client, setup, Console(file=io.StringIO()))
        browser.assert_called_once_with(setup["authorization_url"])
    client.rest_post.assert_awaited_once_with("/api/connectors/conn/poll", {})


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    "http://github.com/login/oauth/authorize", "https://github.com.evil.example/authorize",
    "https://github.com@evil.example/authorize", "https://user@github.com/authorize",
    "https://api.notion.com.evil.example/authorize", "https://slack.com.evil.example/authorize",
    "https://auth.atlassian.com.evil.example/authorize", "https://unreviewed.example/authorize",
    "https://github.com/login/oauth/authorize#fragment",
])
async def test_own_app_authorization_rejects_other_origins_before_browser_or_poll(url):
    client = AsyncMock()
    setup = {"authorization_mode": "own-app", "authorization_url": url,
             "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(), "connection": {"id": "conn"}}
    with patch("openagent_cli.connectors.webbrowser.open") as browser:
        with pytest.raises(click.ClickException, match="invalid"):
            await authorize(client, setup, Console(file=io.StringIO()))
        browser.assert_not_called()
    client.rest_post.assert_not_called()
