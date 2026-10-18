"""Designed CLI fixtures; all traffic is the authenticated gateway mock."""
import io
import json
from unittest.mock import AsyncMock

import click
from click.testing import CliRunner
import pytest
from rich.console import Console

from openagent_cli.connectors import register


def commands(client):
    @click.group()
    def cli():
        pass
    opened, closed = AsyncMock(return_value=(client, None)), AsyncMock()
    register(cli, opened, closed, Console(file=io.StringIO(), width=200))
    return cli, opened, closed


def test_resource_listing_uses_authenticated_post_and_exact_page_query():
    client = AsyncMock()
    client.rest_post.return_value = {"items": [], "selected_site_id": None, "selected_drive_id": None}
    cli, opened, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "microsoft-resources", "conn/one", "--kind", "sites",
                                     "--query", "Research", "--page-token", "opaque_page", "--json",
                                     "--network", "work", "--agent", "assistant", "--handle", "owner"])
    assert result.exit_code == 0, result.output
    opened.assert_awaited_once_with("work", None, "assistant", principal_handle="owner", quiet=True)
    client.rest_post.assert_awaited_once_with("/api/connectors/conn%2Fone/microsoft-resources",
                                           {"kind": "sites", "query": "Research", "page_token": "opaque_page"})
    closed.assert_awaited_once_with(client)


@pytest.mark.parametrize("arguments", [
    ["--kind", "sites"], ["--kind", "sites", "--query", "*"],
    ["--kind", "sites", "--query", "x" * 121], ["--kind", "sites", "--query", "bad\nquery"],
    ["--kind", "drives", "--query", "ignored"],
    ["--kind", "drives", "--page-token", "https://evil.example"],
])
def test_bad_query_or_page_fails_before_gateway_connection(arguments):
    client = AsyncMock()
    cli, opened, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "microsoft-resources", "conn", *arguments])
    assert result.exit_code != 0
    opened.assert_not_awaited()
    client.rest_post.assert_not_awaited()


@pytest.mark.parametrize("name,payload,arguments", [
    ("microsoft-site", {"site_id": "approved-site", "query": "Research", "page_token": "opaque_page"},
     ["select-microsoft-site", "conn/one", "approved-site", "--query", "Research", "--page-token", "opaque_page"]),
    ("microsoft-drive", {"drive_id": "approved-drive", "page_token": "opaque_page"},
     ["select-microsoft-drive", "conn/one", "approved-drive", "--page-token", "opaque_page"]),
])
def test_explicit_selection_uses_only_resource_id_and_original_search_page(name, payload, arguments):
    client = AsyncMock()
    cli, opened, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", *arguments, "--json"])
    assert result.exit_code == 0, result.output
    client.rest_put.assert_awaited_once_with("/api/connectors/conn%2Fone/" + name, payload)
    client.rest_get.assert_not_awaited()
    client.rest_post.assert_not_awaited()
    closed.assert_awaited_once_with(client)


def test_failed_selection_redacts_transport_error_and_disconnects():
    client = AsyncMock()
    client.rest_put.side_effect = RuntimeError("synthetic-private-provider-response")
    cli, opened, closed = commands(client)
    result = CliRunner().invoke(cli, ["connectors", "select-microsoft-drive", "conn", "approved-drive"])
    assert result.exit_code != 0 and "synthetic-private" not in result.output
    closed.assert_awaited_once_with(client)
