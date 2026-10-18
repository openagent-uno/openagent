"""Designed host-binding fixtures using public Core and the normal runner boundary.

No Microsoft calls or consent are performed by these fixtures.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest

from openagent_core.capabilities import CapabilityCatalog
from openagent_core.contracts import PrincipalRef
from openagent_server.official_connectors import OfficialConnectors

SITE = "qa.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222"
OTHER_SITE = SITE.replace("22222222", "33333333")
DRIVE = "b!approved-drive"


class Authorizer:
    allowed = True

    async def authorize(self, *args, **kwargs):
        return self.allowed


class Runner:
    def __init__(self):
        self.calls = []
        self.after_read = None
        self.result = None

    async def close(self):
        pass

    async def call(self, method, params=None):
        self.calls.append((method, params))
        if method == "catalog":
            return [{"id": provider, "name": provider, "auth": "oauth", "available": True,
                     "provider": provider, "capability": "files"} for provider in ("onedrive", "sharepoint")]
        if method == "auth.start":
            return {"id": "t" * 43, "expires_at": "2099-01-01T00:00:00Z",
                    "authorization_url": "https://auth.openagent.uno/authorize/" + "t" * 43}
        if method == "tools":
            return []
        if method == "invoke":
            assert params["arguments"]["top"] == 100
            data = self.result
            if data is None:
                data = {"value": ([{"id": SITE, "displayName": "QA site", "sharepoint_host": "qa.sharepoint.com"}]
                                  if params["tool"].endswith("sites.search") else
                                  [{"id": DRIVE, "name": "QA drive", "driveType": "documentLibrary",
                                    "sharepoint_host": "qa.sharepoint.com"}])}
            if self.after_read:
                await self.after_read()
            return {"data": data}
        return {"ok": True}


@pytest.fixture
async def fixture(tmp_path):
    authorizer = Authorizer()
    runtime = SimpleNamespace(
        agent=SimpleNamespace(name="QA", config={"connectors": {"official_providers": []}},
                              memory_db=SimpleNamespace(db_path=tmp_path / "agent.sqlite")),
        authorizer=authorizer, runtime=SimpleNamespace(capabilities=CapabilityCatalog(authorizer, allow_dynamic=True)))
    runner = Runner()
    service = OfficialConnectors(runtime, runner=runner)
    await service.start()
    service.task.cancel()
    try:
        await service.task
    except asyncio.CancelledError:
        pass
    service.task = None
    principal = PrincipalRef("openagent", "tenant", "owner")
    context = SimpleNamespace(tenant_id="tenant", initiator=principal, audience=(principal,))
    yield service, context, runner, authorizer
    await service.close()


async def connection(fixture, provider="onedrive"):
    service, context, runner, _ = fixture
    service.official_providers.add(provider)
    setup = await service.create(context, {"catalog_id": provider, "config": {}})
    row = await service.record(setup["connection"]["id"])
    token = {"access_token": "synthetic-microsoft-access", "refresh_token": "synthetic-microsoft-refresh",
             "app_id": "openagent-microsoft-qa", "external_id": "tenant:account", "version": 1,
             "scopes": ["User.Read", "Files.Read", "Sites.Read.All"], "authorized_at": "2026-10-18T00:00:00Z"}
    await service.save(row, token, authorization_transaction=row["transaction_id"])
    runner.calls.clear()
    return row["id"], token


@pytest.mark.asyncio
async def test_onedrive_uses_registered_source_then_persists_only_verified_binding(fixture):
    service, context, runner, _ = fixture
    ident, token = await connection(fixture)
    old = service.sources[ident]
    listing = await service.microsoft_resources(context, ident, {"kind": "drives"})
    assert listing == {"items": [{"id": DRIVE, "name": "QA drive", "drive_type": "documentLibrary"}],
                       "selected_site_id": None, "selected_drive_id": None}
    assert "sharepoint_host" not in json.dumps(listing) and "synthetic-microsoft" not in json.dumps(listing)
    selected = await service.select_microsoft_drive(context, ident, {"drive_id": DRIVE})
    assert selected == {"ok": True, "selected_site_id": None, "selected_drive_id": DRIVE}
    current = await service.record(ident)
    assert json.loads(current["config"]) == {"drive_id": DRIVE, "download_host": "qa.sharepoint.com"}
    assert service.decrypt(current) == token
    with pytest.raises(PermissionError, match="replaced"):
        old.require_current_registration()
    calls = [params for method, params in runner.calls if method == "invoke"]
    assert len(calls) == 2 and all(item["arguments"] == {"top": 100} for item in calls)
    assert all(item["tool"] == "files.onedrive.drives.list" for item in calls)
    assert all(item["binding"]["connection"]["config"] == {} for item in calls)


@pytest.mark.asyncio
async def test_sharepoint_site_then_library_and_site_reselection_clears_drive(fixture):
    service, context, runner, _ = fixture
    ident, _ = await connection(fixture, "sharepoint")
    with pytest.raises(ValueError, match="Select a SharePoint site"):
        await service.microsoft_resources(context, ident, {"kind": "drives"})
    assert not [call for call in runner.calls if call[0] == "invoke"]
    query = "QA site"
    assert (await service.microsoft_resources(context, ident, {"kind": "sites", "query": query}))["items"] == [{"id": SITE, "name": "QA site"}]
    await service.select_microsoft_site(context, ident, {"site_id": SITE, "query": query})
    await service.select_microsoft_drive(context, ident, {"drive_id": DRIVE})
    assert json.loads((await service.record(ident))["config"]) == {"site_id": SITE, "drive_id": DRIVE}
    calls = [params for method, params in runner.calls if method == "invoke"]
    assert calls[-1]["binding"]["connection"]["config"] == {"site_id": SITE}
    await service.select_microsoft_site(context, ident, {"site_id": SITE, "query": query})
    assert json.loads((await service.record(ident))["config"]) == {"site_id": SITE}
    assert calls[0]["arguments"] == {"top": 100, "query": query}


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {"kind": "sites", "query": ""}, {"kind": "sites", "query": "*"},
    {"kind": "sites", "query": "x" * 121}, {"kind": "sites", "query": "bad\nquery"},
    {"kind": "drives", "query": "unused"}, {"kind": "drives", "url": "https://evil.example"},
    {"kind": "drives", "page_token": "https://evil.example"},
    {"kind": "drives", "page_token": "a" * 16385}, {"kind": "other"},
])
async def test_closed_payload_and_bounds_reject_before_provider_io(fixture, payload):
    service, context, runner, _ = fixture
    ident, _ = await connection(fixture, "sharepoint")
    with pytest.raises(ValueError):
        await service.microsoft_resources(context, ident, payload)
    assert not [call for call in runner.calls if call[0] == "invoke"]


@pytest.mark.asyncio
async def test_page_forwarding_and_fresh_membership_never_accept_caller_binding(fixture):
    service, context, runner, _ = fixture
    ident, _ = await connection(fixture, "sharepoint")
    runner.result = {"value": [{"id": SITE, "name": "QA"}], "next_page_token": "signed_next_page"}
    result = await service.microsoft_resources(context, ident, {"kind": "sites", "query": "QA", "page_token": "signed_previous"})
    assert result["next_page_token"] == "signed_next_page"
    assert runner.calls[-1][1]["arguments"] == {"top": 100, "query": "QA", "page_token": "signed_previous"}
    with pytest.raises(PermissionError):
        await service.select_microsoft_site(context, ident, {"site_id": OTHER_SITE, "query": "QA", "page_token": "signed_previous"})
    assert (await service.record(ident))["config"] == "{}"
    with pytest.raises(ValueError):
        await service.select_microsoft_site(context, ident, {"site_id": SITE, "query": "QA", "download_host": "evil.example"})
    with pytest.raises(ValueError):
        service.validate_config({"provider": "sharepoint", "auth": "oauth"}, {"site_id": SITE})


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["owner", "tenant", "permission", "revoke_during_read", "credential_during_read"])
async def test_owner_authorization_revocation_and_credential_generation_fence(fixture, kind):
    service, context, runner, authorizer = fixture
    ident, token = await connection(fixture)
    if kind == "owner":
        actor = PrincipalRef("openagent", "tenant", "other")
        context = SimpleNamespace(tenant_id="tenant", initiator=actor, audience=(actor,))
    elif kind == "tenant":
        context = SimpleNamespace(tenant_id="other", initiator=context.initiator, audience=context.audience)
    elif kind == "permission":
        authorizer.allowed = False
    elif kind == "revoke_during_read":
        async def revoke():
            await service.disconnect(context, ident)
        runner.after_read = revoke
    else:
        async def rotate():
            row = await service.record(ident)
            await service.save(row, {**token, "access_token": "synthetic-rotated", "version": 2}, renewal=True)
        runner.after_read = rotate
    with pytest.raises(PermissionError):
        await service.select_microsoft_drive(context, ident, {"drive_id": DRIVE})
    assert (await service.record(ident))["config"] == "{}"
    if kind in {"owner", "tenant", "permission"}:
        assert not [call for call in runner.calls if call[0] == "invoke"]


@pytest.mark.asyncio
async def test_generation_changed_at_sql_admission_cannot_overwrite_binding(fixture):
    service, context, runner, _ = fixture
    ident, token = await connection(fixture)
    owned = service.owned
    calls = 0
    async def racing_owner(context, selected_id):
        nonlocal calls
        row = await owned(context, selected_id)
        calls += 1
        if calls == 4:  # Fresh read admitted, final CAS read returns an older generation.
            await service.save(row, {**token, "access_token": "synthetic-rotated", "version": 2}, renewal=True)
        return row
    service.owned = racing_owner
    with pytest.raises(PermissionError):
        await service.select_microsoft_drive(context, ident, {"drive_id": DRIVE})
    assert (await service.record(ident))["config"] == "{}"


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [
    {"value": [{"id": DRIVE}, {"id": DRIVE}]}, {"value": [{"id": ".."}]},
    {"value": [{"id": DRIVE, "name": "bad\nname"}]},
    {"value": [{"id": DRIVE, "sharepoint_host": "evil.example"}]},
    {"value": [], "next_page_token": "https://evil.example"}, {"value": "wrong"},
])
async def test_invalid_provider_metadata_fails_closed_without_config_write(fixture, result):
    service, context, runner, _ = fixture
    ident, _ = await connection(fixture)
    runner.result = result
    with pytest.raises(RuntimeError):
        await service.select_microsoft_drive(context, ident, {"drive_id": DRIVE})
    assert (await service.record(ident))["config"] == "{}"


@pytest.mark.asyncio
async def test_sharepoint_cross_site_drive_host_is_rejected(fixture):
    service, context, runner, _ = fixture
    ident, _ = await connection(fixture, "sharepoint")
    await service.select_microsoft_site(context, ident, {"site_id": SITE, "query": "QA"})
    runner.result = {"value": [{"id": DRIVE, "name": "Other site", "sharepoint_host": "other.sharepoint.com"}]}
    with pytest.raises(RuntimeError):
        await service.select_microsoft_drive(context, ident, {"drive_id": DRIVE})
    assert json.loads((await service.record(ident))["config"]) == {"site_id": SITE}


@pytest.mark.asyncio
async def test_common_oauth_is_disabled_until_host_configuration_enables_provider(fixture):
    service, context, runner, _ = fixture
    assert all(not item["available"] for item in (await service.catalog(context))["connectors"])
    with pytest.raises(PermissionError):
        await service.create(context, {"catalog_id": "onedrive"})
    assert not [call for call in runner.calls if call[0] == "auth.start"]


@pytest.mark.asyncio
async def test_public_management_routes_require_owner_and_return_no_store(fixture):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from openagent_server.gateway.api import official_connectors as api
    service, context, runner, _ = fixture
    ident, _ = await connection(fixture, "sharepoint")
    async def owner(request, session_id):
        assert session_id == "__catalog_management__"
        if request.headers.get("Authorization") != "Fixture owner":
            raise web.HTTPForbidden()
        return context
    app = web.Application()
    app["gateway"] = SimpleNamespace(runtime_service=SimpleNamespace(context=owner, official_connectors=service))
    app.router.add_post("/{connection_id}/microsoft-resources", api.microsoft_resources)
    app.router.add_put("/{connection_id}/microsoft-site", api.select_microsoft_site)
    app.router.add_put("/{connection_id}/microsoft-drive", api.select_microsoft_drive)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        path = "/" + ident
        assert (await client.post(path + "/microsoft-resources", json={"kind": "sites", "query": "QA"})).status == 403
        headers = {"Authorization": "Fixture owner"}
        listing = await client.post(path + "/microsoft-resources", json={"kind": "sites", "query": "QA"}, headers=headers)
        assert listing.status == 200 and listing.headers["Cache-Control"] == "no-store"
        assert "synthetic-microsoft" not in await listing.text()
        denied = await client.put(path + "/microsoft-site", json={"site_id": OTHER_SITE, "query": "QA"}, headers=headers)
        assert denied.status == 403
        selected = await client.put(path + "/microsoft-site", json={"site_id": SITE, "query": "QA"}, headers=headers)
        assert selected.status == 200 and (await selected.json())["ok"] is True
        invalid = await client.put(path + "/microsoft-drive", json={"drive_id": DRIVE, "credential": "untrusted"}, headers=headers)
        assert invalid.status == 400
    finally:
        await client.close()
