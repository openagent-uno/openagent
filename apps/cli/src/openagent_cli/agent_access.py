"""Manage the selected agent's access through the authenticated gateway."""

import asyncio
import json
from urllib.parse import quote

import click


def register(cli, open_gateway, disconnect):
    @cli.group("agent-access")
    @click.option("--network", default=None, help="Joined network (default: active).")
    @click.option("--agent", default=None, help="Agent to connect to (default: active).")
    @click.option("--handle", default=None, help="Your network username.")
    @click.option("--password", envvar="OPENAGENT_CLI_PASSWORD", default=None,
                  help="Needed only if the saved device certificate has expired.")
    @click.option("--json", "as_json", is_flag=True, help="Print the server response as JSON.")
    @click.pass_context
    def group(ctx, network, agent, handle, password, as_json):
        """View page visibility and transfer primary ownership."""
        ctx.obj = (network, agent, handle, password, as_json)

    def execute(options, method, path, body=None):
        network, agent, handle, password, as_json = options

        async def request():
            client, _ = await open_gateway(network, password, agent, principal_handle=handle, quiet=True)
            if client is None:
                raise click.ClickException("Connect to an OpenAgent network first.")
            try:
                return await client.rest_request(method, path, body)
            finally:
                await disconnect(client)

        try:
            status, data = asyncio.run(request())
        except click.ClickException:
            raise
        except Exception:
            raise click.ClickException("Could not reach the selected agent.") from None
        if status in {404, 405} and (not data or data in ("404: Not Found", "405: Method Not Allowed")):
            raise click.ClickException("Update the server to manage agent access.")
        if status >= 400:
            message = data.get("error") if isinstance(data, dict) else data
            raise click.ClickException(f"HTTP {status}: {message or 'Agent access request failed'}")
        if as_json:
            click.echo(json.dumps(data))
        elif "visibility" in data:
            owner = data.get("owner_handle")
            click.echo(f"Primary owner: {'@' + owner if owner else 'Not assigned'}")
            click.echo("Page visibility: " + ("All members" if data["visibility"] == "members" else "Owner only"))
            if not owner:
                click.echo("A server operator must assign the first owner.")
        else:
            click.echo("Ownership transferred.")

    @group.command("show")
    @click.pass_obj
    def show(options):
        """Show the current owner and page visibility."""
        execute(options, "GET", "/api/agent/access")

    @group.command("visibility")
    @click.argument("value", type=click.Choice(["members", "owner"]))
    @click.pass_obj
    def visibility(options, value):
        """Set who can view Scheduled, Workflows, Events, Connectors and Agent Identity."""
        execute(options, "PATCH", "/api/agent/access", {"visibility": value})

    @group.command("transfer-owner")
    @click.argument("user_handle")
    @click.option("--federated-agent", help="Transfer a peer registered on the connected coordinator.")
    @click.option("--yes", is_flag=True, help="Confirm the transfer without prompting.")
    @click.pass_obj
    def transfer(options, user_handle, federated_agent, yes):
        """Transfer ownership to an active network user."""
        handle = user_handle.strip().lower().removeprefix("@")
        if not handle:
            raise click.UsageError("Enter the new owner's username.")
        if not yes:
            click.confirm(f"Transfer primary ownership to @{handle}?", abort=True)
        path = (f"/api/agent/access/owner/{quote(federated_agent, safe='')}"
                if federated_agent else "/api/agent/access/owner")
        execute(options, "PATCH", path, {"owner_handle": handle})
