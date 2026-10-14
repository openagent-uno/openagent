"""Official marketplace and connection management through the public gateway."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
from urllib.parse import quote, urlsplit
import webbrowser

import click
from rich.prompt import Confirm, Prompt
from rich.table import Table


def catalog_table(items):
    table = Table(title="OpenAgent · Official connectors")
    for column in ("ID", "Service", "Category", "Connection", "Status"):
        table.add_column(column)
    for item in items:
        table.add_row(str(item["id"]), str(item["name"]), str(item.get("category", "")),
                      str(item.get("auth", "")), "Available" if item.get("available") else
                      str(item.get("unavailableReason") or "Not available yet"))
    return table


async def authorize(client, setup, console):
    """Poll outbound; never expose a local callback or print credentials."""
    if not setup.get("authorization_url"):
        if (setup.get("connection") or {}).get("status") != "connected":
            raise click.ClickException("The server did not complete this connection.")
        console.print("Connected to this server.")
        return
    url = urlsplit(setup["authorization_url"])
    origin = f"{url.scheme}://{url.netloc}"
    own = setup.get("authorization_mode") == "own-app"
    import re
    valid = url.scheme == "https" and not url.username and not url.password and not url.fragment
    if own:
        valid = valid and origin in {"https://accounts.google.com", "https://app.clickup.com", "https://platform.postiz.com"}
    else:
        valid = valid and origin == setup.get("authorization_origin", "https://auth.openagent.uno") and not url.query and bool(re.fullmatch(r"/authorize/[A-Za-z0-9_-]{43}", url.path))
    if not valid:
        raise click.ClickException("The server returned an invalid authorization link.")
    expires = datetime.fromisoformat(setup["expires_at"].replace("Z", "+00:00"))
    console.print("Complete authorization in your browser. Ctrl+C stops waiting.")
    console.print(setup["authorization_url"], markup=False)
    webbrowser.open(setup["authorization_url"])
    connection_id = quote(setup["connection"]["id"], safe="")
    while datetime.now(timezone.utc) < expires:
        status = await client.rest_post(f"/api/connectors/{connection_id}/poll", {})
        if status.get("status") == "connected":
            console.print("Connected to this server.")
            return
        if status.get("status") == "cancelled":
            raise click.ClickException("Authorization cancelled.")
        await asyncio.sleep(2)
    raise click.ClickException("Authorization expired. Reconnect to try again.")


async def connect(client, catalog_id, allow_write, console):
    catalog = await client.rest_get("/api/marketplace/official")
    item = next((item for item in catalog.get("connectors", []) if item["id"] == catalog_id), None)
    if item is None:
        raise click.ClickException("Unknown official connector. Use marketplace official to list services.")
    if not item.get("available"):
        raise click.ClickException(item.get("unavailableReason") or "Connector is unavailable.")
    payload = {"catalog_id": catalog_id, "allow_write": allow_write, "config": {}}
    if item["auth"] == "token":
        payload["token"] = Prompt.ask("API token", password=True)
    config = payload["config"]
    if catalog_id == "shopify":
        config["shop"] = Prompt.ask("Shopify store (your-store.myshopify.com)").strip().lower()
    fields = {"replio": ("organization_id", "Organization ID"), "billingbear": ("project_id", "Project ID"),
              "pipeboard": ("ads_provider", "Ads provider (meta_ads or google_ads)")}
    if catalog_id in fields:
        key, label = fields[catalog_id]
        config[key] = Prompt.ask(label).strip()
    if item["auth"] == "credentials":
        config.update(imap_host=Prompt.ask("IMAP host").strip(), username=Prompt.ask("Username").strip(),
                      mailbox=Prompt.ask("Mailbox", default="INBOX").strip(), smtp_host=Prompt.ask("SMTP host").strip())
        config["smtp_from"] = Prompt.ask("Sender email", default=config["username"]).strip()
        for prefix, implicit, starttls in (("imap", 993, 143), ("smtp", 465, 587)):
            tls = Confirm.ask(f"Use STARTTLS for {prefix.upper()}?", default=False)
            config[f"{prefix}_port"] = starttls if tls else implicit
            config["tls_mode" if prefix == "imap" else "smtp_tls_mode"] = "starttls" if tls else "implicit_tls"
        password = Prompt.ask("IMAP password / app password", password=True)
        smtp_password = Prompt.ask("SMTP password (blank to reuse IMAP)", password=True, default="")
        payload["credentials"] = {"imap_password": password, "smtp_password": smtp_password or password}
    try:
        setup = await client.rest_post("/api/connectors", payload)
    finally:
        payload.pop("token", None)
        payload.pop("credentials", None)
    await authorize(client, setup, console)


async def official_menu(client, console):
    catalog = await client.rest_get("/api/marketplace/official")
    console.print(catalog_table(catalog.get("connectors", [])))
    choice = Prompt.ask("Connector ID (blank to return)", default="").strip()
    if choice:
        await connect(client, choice, Confirm.ask("Allow this connector to make changes?", default=False), console)


def register(cli, open_gateway, disconnect, console):
    """Use the same authenticated network/device selection as other CLI commands."""
    def options(function):
        function = click.option("--json", "as_json", is_flag=True)(function)
        function = click.option("--agent", "agent_handle", default=None)(function)
        function = click.option("--handle", "principal_handle", default=None)(function)
        return click.option("--network", "network_name", default=None)(function)

    async def run(operation, network_name, agent_handle, principal_handle):
        client = None
        try:
            client, _ = await open_gateway(network_name, None, agent_handle, principal_handle=principal_handle, quiet=True)
            if client is None:
                raise click.ClickException("No active OpenAgent network. Connect first.")
            await operation(client)
        except click.ClickException:
            raise
        except Exception:
            # Transport/provider exceptions may contain submitted secrets.
            raise click.ClickException("The server could not complete this connector operation. Check connectivity and permissions.") from None
        finally:
            if client is not None:
                await disconnect(client)

    def execute(operation, **options):
        asyncio.run(run(operation, options["network_name"], options["agent_handle"], options["principal_handle"]))

    @cli.group("marketplace")
    def marketplace():
        """Discover official OpenAgent connectors and registry MCPs."""

    @marketplace.command("official")
    @click.argument("query", default="")
    @options
    def official(query, as_json, **options):
        """List official connectors, including unavailable services."""
        async def operation(client):
            response = await client.rest_get("/api/marketplace/official")
            items = [item for item in response.get("connectors", []) if query.lower() in
                     " ".join(str(item.get(key, "")) for key in ("id", "name", "description", "category")).lower()]
            if as_json:
                console.print(json.dumps({"available": response.get("available", False), "connectors": items}), markup=False, highlight=False, soft_wrap=True)
            else:
                console.print(catalog_table(items))
                console.print("Connect with: openagent-cli connectors connect <id>")
        execute(operation, **options)

    @marketplace.command("search")
    @click.argument("query", default="")
    @options
    def search(query, as_json, **options):
        """Search the external MCP registry."""
        async def operation(client):
            response = await client.rest_get("/api/marketplace/search?q=" + quote(query, safe=""))
            if as_json:
                console.print(json.dumps(response), markup=False, highlight=False, soft_wrap=True)
            else:
                table = Table(title="MCP registry")
                for column in ("Name", "Description", "Version"):
                    table.add_column(column)
                for item in response.get("servers", []):
                    table.add_row(str(item.get("name", "")), str(item.get("description", "")), str(item.get("version", "")))
                console.print(table)
        execute(operation, **options)

    @cli.group("connectors")
    def connectors():
        """Manage official connections stored on your server."""

    @connectors.command("list")
    @options
    def connections(as_json, **options):
        async def operation(client):
            response = await client.rest_get("/api/connectors")
            if as_json:
                console.print(json.dumps(response), markup=False, highlight=False, soft_wrap=True)
            else:
                table = Table(title="Official connections · this server")
                for column in ("ID", "Service", "Status", "Changes"):
                    table.add_column(column)
                for row in response.get("connections", []):
                    table.add_row(row["id"], row["display_name"], row["status"], "Allowed" if row["allow_write"] else "Read only")
                console.print(table)
        execute(operation, **options)

    @connectors.command("connect")
    @click.argument("catalog_id")
    @click.option("--allow-write", is_flag=True, help="Allow mutating tools for this connection.")
    @options
    def create(catalog_id, allow_write, as_json, **options):
        if as_json:
            raise click.UsageError("Connection setup is interactive; --json is available for listing.")
        execute(lambda client: connect(client, catalog_id, allow_write, console), **options)

    @connectors.command("reconnect")
    @click.argument("connection_id")
    @options
    def reconnect(connection_id, as_json, **options):
        async def operation(client):
            setup = await client.rest_post(f"/api/connectors/{quote(connection_id, safe='')}/connect", {})
            await authorize(client, setup, console)
        if as_json:
            raise click.UsageError("Reconnect is interactive; --json is available for listing.")
        execute(operation, **options)

    @connectors.command("configure")
    @click.argument("connection_id")
    @click.option("--enabled/--disabled", default=None, help="Enable or pause this server's connection.")
    @click.option("--allow-write/--read-only", default=None, help="Control this server's mutating tools.")
    @options
    def configure(connection_id, enabled, allow_write, as_json, **options):
        payload = {key: value for key, value in {"enabled": enabled, "allow_write": allow_write}.items() if value is not None}
        if not payload:
            raise click.UsageError("Choose --enabled, --disabled, --allow-write or --read-only.")
        async def operation(client):
            await client.rest_put(f"/api/connectors/{quote(connection_id, safe='')}", payload)
            console.print(json.dumps({"ok": True}) if as_json else "Connection settings updated on this server.", markup=False)
        execute(operation, **options)

    @connectors.command("disconnect")
    @click.argument("connection_id")
    @options
    def remove(connection_id, as_json, **options):
        async def operation(client):
            await client.rest_delete(f"/api/connectors/{quote(connection_id, safe='')}")
            console.print(json.dumps({"ok": True}) if as_json else "Disconnected from this server. Other products stay connected.", markup=False)
        execute(operation, **options)
