import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiosqlite
import pytest

from openagent_core.capabilities import CapabilityCatalog
from openagent_core.contracts import PrincipalRef
from openagent_server.official_connectors import OfficialConnectors, OfficialConnectorSource


class Allow:
    allowed = True

    async def authorize(self, *args, **kwargs):
        return self.allowed


class Runner:
    def __init__(self):
        self.calls = []
        self.after_redeem = None
        self.after_catalog = None

    async def close(self):
        pass

    async def call(self, method, params=None):
        self.calls.append((method, params))
        if method == "catalog":
            if self.after_catalog:
                self.after_catalog()
            return [{"id": "replio", "name": "Replio", "auth": "token", "available": True, "provider": "replio", "capability": "outreach"},
                    {"id": "billingbear", "name": "BillingBear", "auth": "token", "available": True, "provider": "billingbear", "capability": "commerce"},
                    {"id": "clickup", "name": "ClickUp", "auth": "oauth", "available": True, "provider": "clickup", "capability": "files"},
                    {"id": "shopify", "name": "Shopify", "auth": "oauth", "available": True, "provider": "shopify", "capability": "commerce"}]
        if method == "auth.start":
            return {"id": "t" * 43, "expires_at": "2099-01-01T00:00:00Z", "authorization_url": "https://auth.openagent.uno/authorize/" + "t" * 43}
        if method == "auth.poll":
            return {"status": "ready"}
        if method == "auth.redeem":
            if self.after_redeem:
                self.after_redeem()
            return {"token": {"access_token": "private-oauth-token", "app_id": "openagent-clickup", "scopes": []}}
        if method == "tools":
            return [{"name": "outreach.replio.apps.list", "description": "Read apps", "risk": "read", "inputSchema": {"type": "object"}}]
        if method == "invoke":
            return {"data": {"ok": True}}
        return {"ok": True}


KEYLESS_CASES = [("exa", "exa", "files.exa.search"),
                 ("firecrawl", "firecrawl", "files.firecrawl.search"),
                 ("parallel-search", "parallel_search", "files.parallel.search"),
                 ("context7", "context7", "files.context7.query_docs"),
                 ("coingecko", "coingecko", "files.coingecko.global")]


def keyless_catalog(runner):
    """Controlled official-catalog fixture, not real provider acceptance."""
    original = runner.call
    runner.keyless_items = [
        {"id": catalog_id, "name": catalog_id.title(), "auth": "none", "available": True,
         "provider": provider, "capability": "files"}
        for catalog_id, provider, _ in KEYLESS_CASES]

    async def call(method, params=None):
        if method == "catalog":
            return await original(method, params) + runner.keyless_items
        if method == "tools" and params["catalog_id"] in {row[0] for row in KEYLESS_CASES}:
            runner.calls.append((method, params))
            tool = next(row[2] for row in KEYLESS_CASES if row[0] == params["catalog_id"])
            return [{"name": tool, "description": "Read public information",
                     "risk": "read", "inputSchema": {"type": "object"}}]
        return await original(method, params)

    runner.call = call


@pytest.fixture
async def fixture(tmp_path):
    authorizer = Allow()
    catalog = CapabilityCatalog(authorizer, allow_dynamic=True)
    runtime = SimpleNamespace(agent=SimpleNamespace(name="Test", config={"connectors": {"official_providers": ["clickup"]}}, memory_db=SimpleNamespace(db_path=tmp_path / "agent.sqlite")),
                              authorizer=authorizer, runtime=SimpleNamespace(capabilities=catalog))
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


@pytest.mark.asyncio
@pytest.mark.parametrize("catalog_id,provider,tool", KEYLESS_CASES)
async def test_keyless_connection_lifecycle_has_no_stored_token(fixture, catalog_id, provider, tool):
    service, context, runner, _ = fixture
    keyless_catalog(runner)
    setup = await service.create(context, {"catalog_id": catalog_id, "config": {}})
    connection_id = setup["connection"]["id"]
    row = await service.record(connection_id)
    assert row["status"] == "connected" and row["enabled"] == 1
    assert all(row[key] is None for key in ("credential", "nonce", "app_id", "group_id", "transaction_id"))
    assert row["token_version"] == 0 and service.decrypt(row) == {}
    assert "authorization_url" not in setup and "credential" not in setup["connection"]
    source = service.sources[connection_id]
    assert (await source.discover(context))[0].name == tool
    assert await source.call_tool(tool, {"query": "public documentation"}, context) == {"ok": True}
    invoke = [params for method, params in runner.calls if method == "invoke"][-1]
    assert invoke["credential"] == {"kind": "none"}
    assert invoke["binding"]["connection"]["id"] == connection_id
    assert invoke["binding"]["connection"]["provider"] == provider
    assert invoke["binding"]["connection"]["scopes"] == []
    assert invoke["binding"]["allow_write"] is False
    await service.update(context, connection_id, {"enabled": False})
    count = len([method for method, _ in runner.calls if method == "invoke"])
    assert await source.discover(context) == ()
    with pytest.raises(PermissionError):
        await source.call_tool(tool, {}, context)
    assert len([method for method, _ in runner.calls if method == "invoke"]) == count
    await service.update(context, connection_id, {"enabled": True})
    with pytest.raises(PermissionError):
        await source.call_tool(tool, {}, context)
    restarted = OfficialConnectors(service.runtime, runner=runner)
    await restarted.start()
    try:
        await restarted.attach_sources()
        current = restarted.sources[connection_id]
        assert await current.call_tool(tool, {}, context) == {"ok": True}
        assert (await restarted.record(connection_id))["credential"] is None
        await restarted.disconnect(context, connection_id)
        assert (await restarted.record(connection_id))["status"] == "disconnected"
        assert await current.discover(context) == ()
        with pytest.raises(PermissionError):
            await current.call_tool(tool, {}, context)
    finally:
        await restarted.close()
    assert not any(method.startswith("auth.") for method, _ in runner.calls)


@pytest.mark.asyncio
async def test_keyless_source_remains_owner_tenant_and_audience_bound(fixture):
    service, context, runner, _ = fixture
    keyless_catalog(runner)
    setup = await service.create(context, {"catalog_id": "exa"})
    source = service.sources[setup["connection"]["id"]]
    other = PrincipalRef("openagent", "tenant", "other")
    for target in (SimpleNamespace(tenant_id="tenant", initiator=other, audience=(other,)),
                   SimpleNamespace(tenant_id="other-tenant", initiator=context.initiator, audience=context.audience),
                   SimpleNamespace(tenant_id="tenant", initiator=context.initiator, audience=(context.initiator, other))):
        assert await source.discover(target) == ()
        with pytest.raises(PermissionError):
            await source.call_tool("files.exa.search", {}, target)
        if target.tenant_id != context.tenant_id or target.initiator != context.initiator:
            with pytest.raises(PermissionError):
                await service.disconnect(target, setup["connection"]["id"])
    assert not any(method == "invoke" for method, _ in runner.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [{"token": None}, {"token": ""}, {"token": "fake"},
                                  {"credentials": None}, {"credentials": {}}, {"auth": "none"},
                                  {"config": {"endpoint": "https://other.example"}},
                                  {"config": None}, {"config": []}])
async def test_keyless_setup_rejects_credentials_and_caller_auth_override(fixture, extra):
    service, context, runner, _ = fixture
    keyless_catalog(runner)
    with pytest.raises(ValueError):
        await service.create(context, {"catalog_id": "exa", **extra})
    assert (await service.list(context))["connections"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("catalog_changes", [{"provider": "replio"}, {"capability": "outreach"},
                                            {"id": "custom", "provider": "custom"}, {"auth": "unknown"}])
async def test_keyless_catalog_contract_cannot_downgrade_another_binding(fixture, catalog_changes):
    service, context, runner, _ = fixture
    keyless_catalog(runner)
    runner.keyless_items[0].update(catalog_changes)
    with pytest.raises(ValueError):
        await service.create(context, {"catalog_id": runner.keyless_items[0]["id"]})
    assert (await service.list(context))["connections"] == []


@pytest.mark.asyncio
async def test_keyless_calls_recheck_the_official_catalog_before_io(fixture):
    service, context, runner, _ = fixture
    keyless_catalog(runner)
    setup = await service.create(context, {"catalog_id": "exa"})
    source = service.sources[setup["connection"]["id"]]
    runner.keyless_items[0]["auth"] = "token"
    with pytest.raises(PermissionError, match="official catalog"):
        await source.call_tool("files.exa.search", {}, context)
    with pytest.raises(PermissionError, match="official catalog"):
        await source.discover(context)
    assert not any(method == "invoke" for method, _ in runner.calls)


@pytest.mark.asyncio
async def test_keyless_connections_never_accept_saved_or_refreshed_credentials(fixture):
    service, context, runner, _ = fixture
    keyless_catalog(runner)
    setup = await service.create(context, {"catalog_id": "firecrawl"})
    row = await service.record(setup["connection"]["id"])
    with pytest.raises(ValueError, match="do not accept credentials"):
        await service.save(row, {"access_token": "fake", "app_id": "personal-token"})
    with pytest.raises(ValueError, match="no refresh credential"):
        await service.refresh(context, row["id"])
    with pytest.raises(ValueError):
        service.credential(row, {"access_token": "fake"})
    row["app_id"] = "personal-token"
    with pytest.raises(PermissionError, match="keyless"):
        service.decrypt(row)
    assert (await service.record(row["id"]))["credential"] is None
    assert not any(method.startswith("auth.") for method, _ in runner.calls)


@pytest.mark.asyncio
async def test_missing_oauth_or_token_credentials_are_not_keyless(fixture):
    service, context, runner, _ = fixture
    with pytest.raises(ValueError, match="token"):
        await service.create(context, {"catalog_id": "replio"})
    setup = await service.create(context, {"catalog_id": "clickup"})
    row = await service.record(setup["connection"]["id"])
    with pytest.raises(RuntimeError, match="authorization"):
        service.decrypt(row)
    assert not any(method == "invoke" for method, _ in runner.calls)


@pytest.mark.asyncio
async def test_revocation_during_keyless_setup_prevents_registration(fixture):
    service, context, runner, authorizer = fixture
    keyless_catalog(runner)
    runner.after_catalog = lambda: setattr(authorizer, "allowed", False)
    with pytest.raises(PermissionError):
        await service.create(context, {"catalog_id": "exa"})
    async with aiosqlite.connect(service.db_path) as db:
        assert (await (await db.execute("SELECT COUNT(*) FROM official_connector_connections")).fetchone())[0] == 0


@pytest.mark.parametrize("config,environment,expected", [
    ({}, {}, {"clickup", "github", "notion"}),
    ({"official_providers": []}, {}, set()),
    ({}, {"OPENAGENT_CONNECTOR_AUTH_PROVIDERS": ""}, set()),
    ({"official_providers": []}, {"OPENAGENT_CONNECTOR_AUTH_PROVIDERS": "clickup"}, set()),
    ({"official_providers": ["github"]}, {}, {"github"}),
    ({}, {"OPENAGENT_CONNECTOR_AUTH_PROVIDERS": "notion"}, {"notion"}),
    ({"official_providers": None}, {}, set()),
    ({"official_providers": "clickup"}, {}, set()),
    ({"official_providers": {"github": True}}, {}, set()),
    ({}, {"OPENAGENT_CONNECTOR_AUTH_PROVIDERS": None}, set()),
])
def test_default_common_providers_preserve_explicit_opt_out(tmp_path, config, environment, expected):
    runner = Runner()
    agent = SimpleNamespace(name="Test", config={"connectors": config},
                            product_environment=environment,
                            memory_db=SimpleNamespace(db_path=tmp_path / "agent.sqlite"))
    service = OfficialConnectors(SimpleNamespace(agent=agent), runner=runner)
    assert service.official_providers == expected
    assert runner.calls == []
    assert all(not service.authorization_available(provider)
               for provider in ("gmail", "google_drive", "google_analytics", "slack_import", "postiz", "shopify",
                                "google_calendar", "outlook_mail", "outlook_calendar"))


def test_explicit_common_opt_out_preserves_local_own_apps(tmp_path):
    providers = tmp_path / "own-providers.json"
    providers.write_text(json.dumps([{"id": "google_drive"}]))
    agent = SimpleNamespace(name="Test", config={"connectors": {"official_providers": [],
                            "oauth_providers_file": str(providers)}}, product_environment={},
                            memory_db=SimpleNamespace(db_path=tmp_path / "agent.sqlite"))
    runner = Runner()
    service = OfficialConnectors(SimpleNamespace(agent=agent), runner=runner)
    assert service.official_providers == set() and service.authorization_available("google_drive")
    assert runner.calls == []


@pytest.mark.parametrize("provider", ["google_calendar", "outlook_mail", "outlook_calendar"])
def test_calendar_mail_own_apps_do_not_enable_other_providers_or_common_oauth(tmp_path, provider):
    providers = tmp_path / "own-providers.json"
    providers.write_text(json.dumps([{"id": provider}]))
    agent = SimpleNamespace(name="Test", config={"connectors": {"official_providers": [],
                            "oauth_providers_file": str(providers)}}, product_environment={},
                            memory_db=SimpleNamespace(db_path=tmp_path / "agent.sqlite"))
    runner = Runner()
    service = OfficialConnectors(SimpleNamespace(agent=agent), runner=runner)
    assert service.official_providers == set()
    assert service.authorization_available(provider)
    assert all(not service.authorization_available(other)
               for other in {"google_calendar", "outlook_mail", "outlook_calendar", "clickup", "github", "notion"} - {provider})
    assert runner.calls == []


@pytest.mark.asyncio
async def test_sdk17_offline_catalog_retains_twenty_two_entries_without_enabling_connections(fixture):
    service, context, runner, _ = fixture
    service.runner = None
    catalog = await service.catalog(context)
    assert catalog["available"] is False
    assert len(catalog["connectors"]) == 22
    assert len({item["id"] for item in catalog["connectors"]}) == 22
    by_id = {item["id"]: item for item in catalog["connectors"]}
    for identifier, provider, capability in (("google-calendar", "google_calendar", "files"),
                                               ("outlook-mail", "outlook_mail", "outreach"),
                                               ("outlook-calendar", "outlook_calendar", "files")):
        item = by_id[identifier]
        assert (item["provider"], item["capability"], item["auth"]) == (provider, capability, "oauth")
        assert item["available"] is False and "runner" in item["unavailableReason"]
    assert runner.calls == []


@pytest.mark.asyncio
async def test_fresh_and_keyless_servers_never_poll_the_broker(fixture):
    service, context, runner, _ = fixture
    service.process_privacy_events = AsyncMock()
    async def background_cycle():
        sleeps = 0
        async def sleep(_):
            nonlocal sleeps
            sleeps += 1
            if sleeps > 1:
                raise asyncio.CancelledError
        with patch("openagent_server.official_connectors.asyncio.sleep", side_effect=sleep):
            with pytest.raises(asyncio.CancelledError):
                await service._synchronize()
    runner.calls.clear()
    await background_cycle()
    assert runner.calls == []
    service.process_privacy_events.assert_awaited_once_with()
    keyless_catalog(runner)
    await service.create(context, {"catalog_id": "exa"})
    runner.calls.clear()
    await background_cycle()
    assert runner.calls == []
    await service.create(context, {"catalog_id": "replio", "token": "rpl_" + "a" * 40,
                                   "config": {"organization_id": "019f8966-755f-7cf2-8511-ef3ed3a57c28"}})
    runner.calls.clear()
    await background_cycle()
    assert runner.calls == []
    assert service.process_privacy_events.await_count == 3


@pytest.mark.asyncio
async def test_explicit_oauth_start_and_existing_grants_keep_background_sync(fixture):
    service, context, _, _ = fixture
    assert not await service._has_broker_registration()
    setup = await service.create(context, {"catalog_id": "clickup"})
    assert await service._has_broker_registration()
    await service.poll(context, setup["connection"]["id"])
    assert await service._has_broker_registration()
    # A local disconnect retains the original issuer/group metadata so that
    # previously enrolled privacy delivery is not silently abandoned.
    await service.disconnect(context, setup["connection"]["id"])
    assert await service._has_broker_registration()


@pytest.mark.asyncio
async def test_token_is_encrypted_and_never_returned_by_management(fixture):
    service, context, runner, _ = fixture
    token = "rpl_" + "a" * 40
    result = await service.create(context, {"catalog_id": "replio", "token": token, "config": {"organization_id": "019f8966-755f-7cf2-8511-ef3ed3a57c28"}})
    connection_id = result["connection"]["id"]
    row = await service.record(connection_id)
    assert service.decrypt(row)["access_token"] == token
    assert token.encode() not in row["credential"]
    assert token not in json.dumps(await service.list(context))
    assert token not in json.dumps(result)
    assert "credential" not in result["connection"]
    source = OfficialConnectorSource(service, connection_id)
    assert await source.discover(context)
    assert await source.call_tool("outreach.replio.apps.list", {}, context) == {"ok": True}


@pytest.mark.asyncio
async def test_missing_runner_keeps_official_catalog_visible_without_enrollment(fixture):
    service, context, _, authorizer = fixture
    service.runner = None
    result = await service.catalog(context)
    assert result["available"] is False
    assert {"gmail", "shopify", "clickup", "replio", "google-drive", "imap_smtp"} <= {item["id"] for item in result["connectors"]}
    assert all(item["available"] is False for item in result["connectors"])
    with pytest.raises(RuntimeError, match="runner"):
        await service.create(context, {"catalog_id": "replio"})
    authorizer.allowed = False
    with pytest.raises(PermissionError):
        await service.catalog(context)


@pytest.mark.asyncio
async def test_connection_cannot_be_used_by_another_principal_or_audience(fixture):
    service, context, _, _ = fixture
    result = await service.create(context, {"catalog_id": "replio", "token": "rpl_" + "a" * 40, "config": {"organization_id": "019f8966-755f-7cf2-8511-ef3ed3a57c28"}})
    connection_id = result["connection"]["id"]
    other = PrincipalRef("openagent", "tenant", "other")
    other_context = SimpleNamespace(tenant_id="tenant", initiator=other, audience=(other,))
    source = OfficialConnectorSource(service, connection_id)
    assert await source.discover(other_context) == ()
    with pytest.raises(PermissionError):
        await source.call_tool("outreach.replio.apps.list", {}, other_context)
    shared = SimpleNamespace(tenant_id="tenant", initiator=context.initiator, audience=(context.initiator, other))
    assert await source.discover(shared) == ()


@pytest.mark.asyncio
async def test_authorization_revoked_during_exchange_prevents_token_persistence(fixture):
    service, context, runner, authorizer = fixture
    setup = await service.create(context, {"catalog_id": "clickup"})
    runner.after_redeem = lambda: setattr(authorizer, "allowed", False)
    with pytest.raises(PermissionError):
        await service.poll(context, setup["connection"]["id"])
    assert (await service.record(setup["connection"]["id"]))["credential"] is None


@pytest.mark.parametrize('shop', ['', 'https://store.myshopify.com', 'Store.myshopify.com',
    '-store.myshopify.com', 'store-.myshopify.com', 'store_name.myshopify.com',
    'a' * 64 + '.myshopify.com', 'store.myshopify.com.attacker.example', None])
def test_shopify_store_rejects_noncanonical_domains(shop):
    with pytest.raises(ValueError):
        OfficialConnectors.validate_config({'provider': 'shopify', 'auth': 'oauth'}, {'shop': shop})


@pytest.mark.asyncio
async def test_shopify_start_is_store_bound_and_enrollment_gate_remains_closed(fixture):
    service, context, runner, _ = fixture
    payload = {'catalog_id': 'shopify', 'config': {'shop': 'qa-store.myshopify.com'}}
    with pytest.raises(PermissionError):
        await service.create(context, payload)
    assert not any(method == 'auth.start' for method, _ in runner.calls)
    # Exercise the request contract behind the independent rollout gate,
    # without enabling a real provider or changing the production gate.
    service.authorization_available = lambda provider: provider == 'shopify'
    setup = await service.create(context, payload)
    assert ('auth.start', {'provider': 'shopify', 'shop': 'qa-store.myshopify.com'}) in runner.calls
    row = await service.record(setup['connection']['id'])
    assert json.loads(row['config']) == payload['config']
    with pytest.raises(PermissionError, match='another store'):
        await service.save(row, {'access_token': 'fixture', 'app_id': 'fixture-app',
                                'external_id': 'other-store.myshopify.com'}, authorization_transaction=row['transaction_id'])
    assert (await service.record(row['id']))['credential'] is None


@pytest.mark.asyncio
async def test_shopify_reconnect_uses_verified_legacy_store_or_rejects_before_auth_io(fixture):
    service, context, runner, _ = fixture
    service.authorization_available = lambda provider: provider == 'shopify'
    setup = await service.create(context, {'catalog_id': 'shopify', 'config': {'shop': 'qa-store.myshopify.com'}})
    row = await service.record(setup['connection']['id'])
    await service.save(row, {'access_token': 'fixture', 'app_id': 'fixture-app',
                            'external_id': 'qa-store.myshopify.com'}, authorization_transaction=row['transaction_id'])
    async with aiosqlite.connect(service.db_path) as db:
        await db.execute("UPDATE official_connector_connections SET config='{}' WHERE id=?", (row['id'],))
        await db.commit()
    runner.calls.clear()
    await service.connect(context, row['id'])
    assert ('auth.start', {'provider': 'shopify', 'shop': 'qa-store.myshopify.com'}) in runner.calls
    async with aiosqlite.connect(service.db_path) as db:
        await db.execute("UPDATE official_connector_connections SET credential=NULL,nonce=NULL WHERE id=?", (row['id'],))
        await db.commit()
    runner.calls.clear()
    with pytest.raises(ValueError, match='store is required'):
        await service.connect(context, row['id'])
    assert runner.calls == [('catalog', None)]


@pytest.mark.asyncio
async def test_disconnect_immediately_revokes_source_and_clears_local_token(fixture):
    service, context, _, _ = fixture
    result = await service.create(context, {"catalog_id": "replio", "token": "rpl_" + "a" * 40, "config": {"organization_id": "019f8966-755f-7cf2-8511-ef3ed3a57c28"}})
    connection_id = result["connection"]["id"]
    source = OfficialConnectorSource(service, connection_id)
    await service.disconnect(context, connection_id)
    row = await service.record(connection_id)
    assert row["credential"] is None and row["status"] == "disconnected"
    assert await source.discover(context) == ()


@pytest.mark.asyncio
async def test_credential_encryption_binds_connection_and_owner(fixture):
    service, context, _, _ = fixture
    result = await service.create(context, {"catalog_id": "replio", "token": "rpl_" + "a" * 40, "config": {"organization_id": "019f8966-755f-7cf2-8511-ef3ed3a57c28"}})
    row = await service.record(result["connection"]["id"])
    row["owner_key"] = "another-owner"
    with pytest.raises(Exception):
        service.decrypt(row)


@pytest.mark.asyncio
@pytest.mark.parametrize("encrypted_kind", ["credential", "privacy_event"])
async def test_missing_key_never_reinitializes_existing_encrypted_state(fixture, encrypted_kind):
    service, context, runner, _ = fixture
    if encrypted_kind == "credential":
        setup = await service.create(context, {"catalog_id": "replio", "token": "rpl_" + "a" * 40,
                                               "config": {"organization_id": "019f8966-755f-7cf2-8511-ef3ed3a57c28"}})
        original = await service.record(setup["connection"]["id"])
    else:
        async with aiosqlite.connect(service.db_path) as db:
            await db.execute("INSERT INTO official_connector_events(id,group_id,topic,ciphertext,nonce,received_at) VALUES(?,?,?,?,?,?)",
                             ("event-fixture", "group-fixture", "customers/redact", b"encrypted-fixture", b"nonce", "2026-10-13T00:00:00Z"))
            await db.commit()
    key_path = service.db_path.parent / "connector-credential-key"
    # Model a partial backup restore in this disposable fixture directory.
    original_key = key_path.read_bytes()
    key_path.unlink()
    restarted = OfficialConnectors(service.runtime, runner=runner)
    with pytest.raises(RuntimeError, match="Restore the matching"):
        await restarted.start()
    assert not key_path.exists()
    if encrypted_kind == "credential":
        assert (await service.record(original["id"]))["credential"] == original["credential"]
        key_path.write_bytes(original_key)
        restored = OfficialConnectors(service.runtime, runner=runner)
        await restored.start()
        try:
            assert restored.decrypt(await restored.record(original["id"]))["access_token"] == "rpl_" + "a" * 40
        finally:
            await restored.close()
    else:
        async with aiosqlite.connect(service.db_path) as db:
            row = await (await db.execute("SELECT ciphertext FROM official_connector_events WHERE id='event-fixture'")).fetchone()
        assert row[0] == b"encrypted-fixture"


@pytest.mark.asyncio
async def test_oauth_completed_connection_survives_service_restart(fixture):
    service, context, runner, _ = fixture
    setup = await service.create(context, {"catalog_id": "clickup"})
    completed = await service.poll(context, setup["connection"]["id"])
    assert completed["status"] == "connected"
    restarted = OfficialConnectors(service.runtime, runner=runner)
    await restarted.start()
    try:
        row = await restarted.record(setup["connection"]["id"])
        assert restarted.decrypt(row)["access_token"] == "private-oauth-token"
        assert "private-oauth-token" not in json.dumps(await restarted.list(context))
    finally:
        await restarted.close()

@pytest.mark.asyncio
async def test_explicit_reauthorization_changes_issuer_without_generation_confusion(fixture):
    service, context, runner, _ = fixture
    result = await service.create(context, {"catalog_id": "clickup"})
    connection_id = result["connection"]["id"]
    row = await service.record(connection_id)
    await service.save(row, {"access_token": "old-test-token", "app_id": "old-test-app", "version": 7, "scopes": []})
    await service.connect(context, connection_id)
    row = await service.record(connection_id)
    await service.save(row, {"access_token": "new-test-token", "app_id": "new-test-app", "version": 0, "scopes": []},
                       authorization_transaction=row["transaction_id"])
    current = await service.record(connection_id)
    assert current["id"] == connection_id
    assert current["app_id"] == "new-test-app"
    assert current["token_version"] == 0
    with pytest.raises(PermissionError):
        await service.save(current, {"access_token": "wrong-app-token", "app_id": "another-app", "version": 20, "scopes": []})
    assert service.decrypt(await service.record(connection_id))["access_token"] == "new-test-token"

@pytest.mark.asyncio
async def test_superseded_consent_cannot_save_credentials(fixture):
    service, context, _, _ = fixture
    result = await service.create(context, {"catalog_id": "clickup"})
    row = await service.record(result["connection"]["id"])
    async with aiosqlite.connect(service.db_path) as db:
        await db.execute("UPDATE official_connector_connections SET transaction_id='replacement' WHERE id=?", (row["id"],))
        await db.commit()
    with pytest.raises(PermissionError):
        await service.save(row, {"access_token": "superseded-token", "app_id": "test-app", "scopes": []},
                           authorization_transaction=row["transaction_id"])
    assert (await service.record(row["id"]))["credential"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [
    {'catalog_id': 'billingbear', 'token': 'sk_admin_' + 'a' * 32, 'config': {'project_id': 'project'}},
    {'catalog_id': 'billingbear', 'token': 'sk_' + 'a' * 32, 'config': {'project_id': 'project', 'metadata': {'private_key': 'must-not-store'}}},
    {'catalog_id': 'replio', 'token': 'rpl_' + 'a' * 40, 'config': {'organization_id': 'invalid-org'}},
    {'catalog_id': 'replio', 'token': 'invalid-token', 'config': {'organization_id': '019f8966-755f-7cf2-8511-ef3ed3a57c28'}},
])
async def test_invalid_credential_setup_never_creates_a_connection(fixture, payload):
    service, context, _, _ = fixture
    with pytest.raises(ValueError):
        await service.create(context, payload)
    assert (await service.list(context))['connections'] == []


@pytest.mark.asyncio
async def test_role_revocation_during_token_setup_prevents_persistence(fixture):
    service, context, runner, authorizer = fixture
    runner.after_catalog = lambda: setattr(authorizer, 'allowed', False)
    with pytest.raises(PermissionError):
        await service.create(context, {'catalog_id': 'replio', 'token': 'rpl_' + 'a' * 40,
                                       'config': {'organization_id': '019f8966-755f-7cf2-8511-ef3ed3a57c28'}})
    async with aiosqlite.connect(service.db_path) as db:
        count = await (await db.execute('SELECT COUNT(*) FROM official_connector_connections')).fetchone()
    assert count[0] == 0


@pytest.mark.asyncio
async def test_common_consent_requires_host_opt_in(fixture):
    service, context, runner, _ = fixture
    service.official_providers.clear()
    catalog = await service.catalog(context)
    clickup = next(item for item in catalog['connectors'] if item['id'] == 'clickup')
    assert clickup['available'] is False
    with pytest.raises(PermissionError):
        await service.create(context, {'catalog_id': 'clickup'})
    assert not any(method == 'auth.start' for method, _ in runner.calls)
    assert (await service.list(context))['connections'] == []


@pytest.mark.asyncio
async def test_disabling_enrollment_does_not_disable_valid_stored_tokens(fixture):
    service, context, runner, _ = fixture
    setup = await service.create(context, {'catalog_id': 'clickup'})
    await service.poll(context, setup['connection']['id'])
    service.official_providers.clear()
    source = OfficialConnectorSource(service, setup['connection']['id'])
    assert await source.call_tool('files.clickup.user.get', {}, context) == {'ok': True}
    with pytest.raises(PermissionError):
        await service.connect(context, setup['connection']['id'])


@pytest.mark.asyncio
async def test_shopify_enrollment_waits_for_standalone_privacy_processing(fixture):
    service, _, _, _ = fixture
    service.official_providers.add('shopify')
    assert not service.authorization_available('shopify')


async def refreshable_connection(fixture, *, refresh_token="held-refresh", expiry=None):
    """Synthetic held grant; no provider calls or invented expiration required."""
    service, context, runner, _ = fixture
    setup = await service.create(context, {"catalog_id": "clickup"})
    row = await service.record(setup["connection"]["id"])
    token = {"access_token": "held-access", "app_id": "openagent-clickup", "scopes": [],
             "authorized_at": "2026-10-16T08:00:00Z", "version": 1}
    if refresh_token is not None:
        token["refresh_token"] = refresh_token
    if expiry:
        token["expires_at"] = expiry
    await service.save(row, token, authorization_transaction=row["transaction_id"])
    runner.calls.clear()
    return row["id"], token


def rotated_runner(runner, token, *, during_refresh=None):
    original = runner.call
    async def call(method, params=None):
        if method != "auth.refresh":
            return await original(method, params)
        runner.calls.append((method, params))
        if during_refresh:
            await during_refresh()
        return {"token": {**token, "access_token": "rotated-access", "refresh_token": "rotated-refresh",
                          "version": token["version"] + 1}}
    runner.call = call


@pytest.mark.asyncio
async def test_owner_explicit_refresh_without_expiration_rotates_pair_and_keeps_registration(fixture):
    service, context, runner, _ = fixture
    connection_id, token = await refreshable_connection(fixture)
    registration = service.sources[connection_id]
    rotated_runner(runner, token)
    result = await service.refresh(context, connection_id)
    current = await service.record(connection_id)
    rotated = service.decrypt(current)
    assert rotated["access_token"] == "rotated-access"
    assert rotated["refresh_token"] == "rotated-refresh"
    assert "expires_at" not in rotated
    assert service.sources[connection_id] is registration
    assert [method for method, _ in runner.calls].count("auth.refresh") == 1
    assert "held-refresh" not in json.dumps(result) and "rotated-access" not in json.dumps(result)
    assert result["status"] == "connected" and result["connection"]["allow_write"] == 0
    assert b"rotated-refresh" not in current["credential"]
    restarted = OfficialConnectors(service.runtime, runner=runner)
    await restarted.start()
    try:
        assert restarted.decrypt(await restarted.record(connection_id))["refresh_token"] == "rotated-refresh"
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_explicit_refresh_does_not_require_new_enrollment_opt_in(fixture):
    service, context, runner, _ = fixture
    connection_id, token = await refreshable_connection(fixture)
    service.official_providers.clear()
    rotated_runner(runner, token)
    assert (await service.refresh(context, connection_id))["status"] == "connected"
    assert not any(method == "auth.start" for method, _ in runner.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("refresh_token", [None, ""])
async def test_explicit_refresh_without_refresh_credential_fails_before_runner(fixture, refresh_token):
    service, context, runner, _ = fixture
    connection_id, _ = await refreshable_connection(fixture, refresh_token=refresh_token)
    with pytest.raises(ValueError, match="no refresh credential"):
        await service.refresh(context, connection_id)
    assert runner.calls == []


@pytest.mark.asyncio
async def test_explicit_refresh_rejects_personal_token_before_runner(fixture):
    service, context, runner, _ = fixture
    setup = await service.create(context, {"catalog_id": "replio", "token": "rpl_" + "a" * 40,
        "config": {"organization_id": "019f8966-755f-7cf2-8511-ef3ed3a57c28"}})
    runner.calls.clear()
    with pytest.raises(PermissionError, match="Only an OAuth"):
        await service.refresh(context, setup["connection"]["id"])
    assert runner.calls == []


@pytest.mark.asyncio
async def test_non_oauth_catalog_entry_cannot_refresh_even_with_synthetic_refresh_field(fixture):
    service, context, runner, _ = fixture
    connection_id, token = await refreshable_connection(fixture)
    original = runner.call
    async def non_oauth(method, params=None):
        result = await original(method, params)
        if method == "catalog":
            return [{**item, "auth": "token"} for item in result]
        return result
    runner.call = non_oauth
    with pytest.raises(PermissionError, match="Only an OAuth"):
        await service.refresh(context, connection_id)
    assert not any(method == "auth.refresh" for method, _ in runner.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("unauthorized", ["owner", "tenant", "audience", "role", "disabled", "disconnected"])
async def test_explicit_refresh_rejects_unauthorized_or_inactive_binding_before_runner(fixture, unauthorized):
    service, context, runner, authorizer = fixture
    connection_id, _ = await refreshable_connection(fixture)
    other = PrincipalRef("openagent", "tenant", "other")
    if unauthorized == "owner":
        context = SimpleNamespace(tenant_id=context.tenant_id, initiator=other, audience=(other,))
    elif unauthorized == "tenant":
        context = SimpleNamespace(tenant_id="other", initiator=context.initiator, audience=context.audience)
    elif unauthorized == "audience":
        context = SimpleNamespace(tenant_id=context.tenant_id, initiator=context.initiator, audience=(context.initiator, other))
    elif unauthorized == "role":
        authorizer.allowed = False
    elif unauthorized == "disabled":
        await service.update(context, connection_id, {"enabled": False})
    else:
        await service.disconnect(context, connection_id)
    runner.calls.clear()
    with pytest.raises(PermissionError):
        await service.refresh(context, connection_id)
    assert runner.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("revocation", ["role", "disabled", "permissions", "new_consent", "credential_generation"])
async def test_explicit_refresh_cannot_overwrite_changes_during_broker_io(fixture, revocation):
    service, context, runner, authorizer = fixture
    connection_id, token = await refreshable_connection(fixture)
    original = await service.record(connection_id)
    async def revoke():
        if revocation == "role":
            authorizer.allowed = False
        elif revocation == "disabled":
            await service.update(context, connection_id, {"enabled": False})
        elif revocation == "permissions":
            await service.update(context, connection_id, {"allow_write": True})
        elif revocation == "new_consent":
            await service.connect(context, connection_id)
            pending = await service.record(connection_id)
            await service.save(pending, {**token, "access_token": "replacement-grant", "refresh_token": "replacement-refresh",
                                       "authorized_at": "2026-10-16T09:00:00Z"},
                               authorization_transaction=pending["transaction_id"])
        else:
            await service.save(original, {**token, "access_token": "concurrent-access", "refresh_token": "concurrent-refresh",
                                          "version": 3}, renewal=True)
    rotated_runner(runner, token, during_refresh=revoke)
    with pytest.raises(PermissionError):
        await service.refresh(context, connection_id)
    current = await service.record(connection_id)
    assert service.decrypt(current)["access_token"] == (
        "replacement-grant" if revocation == "new_consent" else
        "concurrent-access" if revocation == "credential_generation" else "held-access")


@pytest.mark.asyncio
async def test_explicit_refresh_fails_on_broker_outage_without_success_fallback(fixture):
    service, context, runner, _ = fixture
    connection_id, _ = await refreshable_connection(fixture, expiry="2099-01-01T00:00:00Z")
    before = await service.record(connection_id)
    original = runner.call
    async def unavailable(method, params=None):
        if method == "auth.refresh":
            raise RuntimeError("private-provider-error")
        return await original(method, params)
    runner.call = unavailable
    with pytest.raises(RuntimeError):
        await service.refresh(context, connection_id)
    after = await service.record(connection_id)
    assert after["credential"] == before["credential"] and after["nonce"] == before["nonce"]


@pytest.mark.asyncio
async def test_concurrent_explicit_refreshes_serialize_and_use_latest_held_pair(fixture):
    service, context, runner, _ = fixture
    connection_id, token = await refreshable_connection(fixture)
    original = runner.call
    used = []
    async def rotate(method, params=None):
        if method != "auth.refresh":
            return await original(method, params)
        used.append(params["token"]["refresh_token"])
        await asyncio.sleep(0)
        return {"token": {**token, "access_token": "access-" + str(len(used)),
                          "refresh_token": "refresh-" + str(len(used)), "version": len(used) + 1}}
    runner.call = rotate
    await asyncio.gather(service.refresh(context, connection_id), service.refresh(context, connection_id))
    assert used == ["held-refresh", "refresh-1"]
    assert service.decrypt(await service.record(connection_id))["refresh_token"] == "refresh-2"


@pytest.mark.asyncio
async def test_reconsent_during_catalog_check_denies_stale_refresh_before_broker_io(fixture):
    service, context, runner, _ = fixture
    connection_id, token = await refreshable_connection(fixture)
    original = runner.call
    changed = False
    async def catalog_with_new_grant(method, params=None):
        nonlocal changed
        result = await original(method, params)
        if method == "catalog" and not changed:
            changed = True
            await service.connect(context, connection_id)
            pending = await service.record(connection_id)
            await service.save(pending, {**token, "access_token": "new-grant",
                                       "authorized_at": "2026-10-16T09:00:00Z"},
                               authorization_transaction=pending["transaction_id"])
        return result
    runner.call = catalog_with_new_grant
    with pytest.raises(PermissionError):
        await service.refresh(context, connection_id)
    assert not any(method == "auth.refresh" for method, _ in runner.calls)
    assert service.decrypt(await service.record(connection_id))["access_token"] == "new-grant"


@pytest.mark.asyncio
async def test_public_refresh_route_checks_current_owner_and_returns_no_credential(fixture):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from openagent_server.gateway.api import official_connectors as api
    service, context, runner, authorizer = fixture
    connection_id, token = await refreshable_connection(fixture)
    rotated_runner(runner, token)
    async def authenticated_context(request, session_id):
        assert session_id == "__catalog_management__"
        if request.headers.get("Authorization") != "Fixture owner":
            raise web.HTTPForbidden()
        return context
    app = web.Application()
    app["gateway"] = SimpleNamespace(runtime_service=SimpleNamespace(context=authenticated_context, official_connectors=service))
    app.router.add_post("/api/connectors/{connection_id}/refresh", api.refresh)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        url = f"/api/connectors/{connection_id}/refresh"
        denied = await client.post(url, json={})
        assert denied.status == 403 and runner.calls == []
        response = await client.post(url, json={}, headers={"Authorization": "Fixture owner"})
        assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
        body = await response.text()
        assert "held-refresh" not in body and "rotated-refresh" not in body and "rotated-access" not in body
        original = runner.call
        async def unavailable(method, params=None):
            if method == "auth.refresh":
                raise RuntimeError("private-token-and-provider-response")
            return await original(method, params)
        runner.call = unavailable
        failure = await client.post(url, json={}, headers={"Authorization": "Fixture owner"})
        assert failure.status == 503
        assert "private-token" not in await failure.text()
        authorizer.allowed = False
        denied = await client.post(url, json={}, headers={"Authorization": "Fixture owner"})
        assert denied.status == 403
    finally:
        await client.close()


ATLASSIAN_SITE = "1324a887-45db-1bf4-1e99-ef0ff456d421"
ATLASSIAN_OTHER_SITE = "2324a887-45db-1bf4-1e99-ef0ff456d421"


async def atlassian_connection(fixture, *, allow_write=False, resources=None):
    service, context, runner, _ = fixture
    original = runner.call
    scopes = ["read:jira-work", "write:jira-work"]
    if resources is None:
        resources = [{"id": ATLASSIAN_SITE, "name": "QA Jira", "url": "https://qa.atlassian.net", "scopes": scopes}]
    async def call(method, params=None):
        if method == "catalog":
            return [*(await original(method, params)), {"id": "atlassian", "name": "Atlassian",
                "auth": "oauth", "available": True, "provider": "atlassian", "capability": "files"}]
        if method == "invoke":
            runner.calls.append((method, params))
            assert params["tool"] == "files.atlassian.resources.list" and params["arguments"] == {}
            return {"data": resources}
        return await original(method, params)
    runner.call = call
    service.official_providers.add("atlassian")
    setup = await service.create(context, {"catalog_id": "atlassian", "allow_write": allow_write})
    row = await service.record(setup["connection"]["id"])
    token = {"access_token": "private-atlassian-access", "refresh_token": "private-atlassian-refresh",
             "app_id": "atlassian-qa", "scopes": scopes, "authorized_at": "2026-10-16T08:00:00Z", "version": 1}
    await service.save(row, token, authorization_transaction=row["transaction_id"])
    runner.calls.clear()
    return row["id"], token


@pytest.mark.asyncio
async def test_atlassian_site_selection_uses_provider_resources_and_revokes_previous_reference(fixture):
    service, context, runner, _ = fixture
    connection_id, token = await atlassian_connection(fixture)
    source = service.sources[connection_id]
    listed = await service.sites(context, connection_id)
    assert listed["selected_cloud_id"] is None and [site["id"] for site in listed["sites"]] == [ATLASSIAN_SITE]
    assert "private-atlassian" not in json.dumps(listed)
    assert (await service.record(connection_id))["config"] == "{}"
    selected = await service.select_site(context, connection_id, {"cloud_id": ATLASSIAN_SITE})
    assert selected == {"ok": True, "cloud_id": ATLASSIAN_SITE}
    current = await service.record(connection_id)
    assert json.loads(current["config"]) == {"cloud_id": ATLASSIAN_SITE}
    assert service.decrypt(current) == token
    with pytest.raises(PermissionError, match="replaced"):
        source.require_current_registration()
    assert service.sources[connection_id] is not source
    assert (await service.sites(context, connection_id))["selected_cloud_id"] == ATLASSIAN_SITE
    invocations = [params for method, params in runner.calls if method == "invoke"]
    assert len(invocations) == 3  # PUT fetches a fresh provider list; no client attestation.
    assert invocations[0]["binding"]["connection"]["config"] == {}
    assert invocations[-1]["binding"]["connection"]["config"] == {"cloud_id": ATLASSIAN_SITE}
    assert all(params["arguments"] == {} for params in invocations)


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{"cloud_id": "not-a-uuid"}, {"cloud_id": "00000000-0000-0000-0000-000000000000"},
    {"cloud_id": ATLASSIAN_SITE.upper()}, {"cloud_id": ATLASSIAN_SITE, "url": "https://other.example"}])
async def test_atlassian_site_selection_rejects_untrusted_configuration_before_io(fixture, payload):
    service, context, runner, _ = fixture
    connection_id, _ = await atlassian_connection(fixture)
    with pytest.raises(ValueError):
        await service.select_site(context, connection_id, payload)
    assert runner.calls == []
    assert (await service.record(connection_id))["config"] == "{}"
    with pytest.raises(ValueError):
        OfficialConnectors.validate_config({"auth": "oauth", "provider": "atlassian"}, {"cloud_id": ATLASSIAN_SITE})


@pytest.mark.asyncio
@pytest.mark.parametrize("allow_write", [False, True])
async def test_atlassian_sites_filter_resource_scopes_and_require_selected_membership(fixture, allow_write):
    service, context, _, _ = fixture
    resources = [{"id": ATLASSIAN_SITE, "name": "Read only Jira", "scopes": ["read:jira-work"]},
                 {"id": ATLASSIAN_OTHER_SITE, "name": "Confluence only", "scopes": ["read:confluence-content.all"]}]
    connection_id, _ = await atlassian_connection(fixture, allow_write=allow_write, resources=resources)
    sites = (await service.sites(context, connection_id))["sites"]
    assert [site["id"] for site in sites] == ([] if allow_write else [ATLASSIAN_SITE])
    with pytest.raises(PermissionError, match="not granted"):
        await service.select_site(context, connection_id, {"cloud_id": ATLASSIAN_OTHER_SITE})
    assert (await service.record(connection_id))["config"] == "{}"


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["duplicate", "malformed_id", "malformed_scopes", "control_character", "unsafe_url"])
async def test_atlassian_resources_fail_closed_on_ambiguous_or_malformed_provider_data(fixture, invalid):
    service, context, _, _ = fixture
    resource = {"id": ATLASSIAN_SITE, "name": "Jira", "scopes": ["read:jira-work"]}
    resources = [resource]
    if invalid == "duplicate":
        resources.append(dict(resource))
    elif invalid == "malformed_id":
        resource["id"] = "other/site"
    elif invalid == "malformed_scopes":
        resource["scopes"] = "read:jira-work"
    elif invalid == "control_character":
        resource["name"] = "Jira\x1b[31m"
    else:
        resource["url"] = "javascript:alert(1)"
    connection_id, _ = await atlassian_connection(fixture, resources=resources)
    with pytest.raises(RuntimeError):
        await service.select_site(context, connection_id, {"cloud_id": ATLASSIAN_SITE})
    assert (await service.record(connection_id))["config"] == "{}"


@pytest.mark.asyncio
@pytest.mark.parametrize("revocation", ["owner", "tenant", "role", "during_io"])
async def test_atlassian_site_management_rechecks_owner_acl_and_provider_io(fixture, revocation):
    service, context, runner, authorizer = fixture
    connection_id, _ = await atlassian_connection(fixture)
    if revocation == "owner":
        other = PrincipalRef("openagent", "tenant", "other")
        context = SimpleNamespace(tenant_id=context.tenant_id, initiator=other, audience=(other,))
    elif revocation == "tenant":
        context = SimpleNamespace(tenant_id="other", initiator=context.initiator, audience=context.audience)
    elif revocation == "role":
        authorizer.allowed = False
    else:
        original = runner.call
        async def revoked_during_io(method, params=None):
            result = await original(method, params)
            if method == "invoke":
                authorizer.allowed = False
            return result
        runner.call = revoked_during_io
    with pytest.raises(PermissionError):
        await service.select_site(context, connection_id, {"cloud_id": ATLASSIAN_SITE})
    assert (await service.record(connection_id))["config"] == "{}"
    if revocation != "during_io":
        assert runner.calls == []


@pytest.mark.asyncio
async def test_atlassian_site_storage_cas_rejects_concurrent_credential_generation(fixture):
    service, context, _, _ = fixture
    connection_id, token = await atlassian_connection(fixture)
    original = service.owned
    calls = 0
    async def concurrent_renewal(context, selected_id):
        nonlocal calls
        row = await original(context, selected_id)
        calls += 1
        if calls == 3:  # Selection admission after provider IO, before its SQL CAS.
            await service.save(row, {**token, "access_token": "concurrent-access", "version": 2}, renewal=True)
        return row
    service.owned = concurrent_renewal
    with pytest.raises(PermissionError, match="changed during site selection"):
        await service.select_site(context, connection_id, {"cloud_id": ATLASSIAN_SITE})
    current = await service.record(connection_id)
    assert current["config"] == "{}" and service.decrypt(current)["access_token"] == "concurrent-access"


@pytest.mark.asyncio
async def test_public_atlassian_site_routes_are_owner_only_no_store_and_do_not_accept_scope_claims(fixture):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from openagent_server.gateway.api import official_connectors as api
    service, context, _, _ = fixture
    connection_id, _ = await atlassian_connection(fixture)
    async def owner_context(request, session_id):
        assert session_id == "__catalog_management__"
        if request.headers.get("Authorization") != "Fixture owner":
            raise web.HTTPForbidden()
        return context
    app = web.Application()
    app["gateway"] = SimpleNamespace(runtime_service=SimpleNamespace(context=owner_context, official_connectors=service))
    app.router.add_get("/api/connectors/{connection_id}/sites", api.sites)
    app.router.add_put("/api/connectors/{connection_id}/site", api.select_site)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        path = f"/api/connectors/{connection_id}"
        assert (await client.get(path + "/sites")).status == 403
        headers = {"Authorization": "Fixture owner"}
        listing = await client.get(path + "/sites", headers=headers)
        assert listing.status == 200 and listing.headers["Cache-Control"] == "no-store"
        assert (await listing.json())["selected_cloud_id"] is None
        invalid = await client.put(path + "/site", headers=headers, json={"cloud_id": ATLASSIAN_OTHER_SITE, "scopes": ["read:jira-work"]})
        assert invalid.status == 400
        denied = await client.put(path + "/site", headers=headers, json={"cloud_id": ATLASSIAN_OTHER_SITE})
        assert denied.status == 403
        selected = await client.put(path + "/site", headers=headers, json={"cloud_id": ATLASSIAN_SITE})
        assert selected.status == 200 and selected.headers["Cache-Control"] == "no-store"
        assert await selected.json() == {"ok": True, "cloud_id": ATLASSIAN_SITE}
        listing = await client.get(path + "/sites", headers=headers)
        assert (await listing.json())["selected_cloud_id"] == ATLASSIAN_SITE
        assert "private-atlassian" not in await listing.text()
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('provider', ['supabase', 'postman'])
async def test_admitted_token_provider_uses_encrypted_lifecycle_and_manifest_auth(fixture, provider):
    service, context, runner, _ = fixture
    original = runner.call
    tool = f'files.{provider}.projects.list'

    async def catalog_call(method, params=None):
        if method == 'catalog':
            return await original(method, params) + [{
                'id': provider, 'name': provider, 'auth': 'token', 'available': True,
                'provider': provider, 'capability': 'files', 'readTools': [tool], 'agentTools': [],
            }]
        return await original(method, params)

    runner.call = catalog_call
    token = 'private-fixture-token-123'
    setup = await service.create(context, {'catalog_id': provider, 'token': token, 'config': {}})
    connection_id = setup['connection']['id']
    row = await service.record(connection_id)
    assert row['status'] == 'connected' and row['allow_write'] == 0
    assert token.encode() not in row['credential'] and service.decrypt(row)['access_token'] == token
    assert token not in json.dumps(setup) and token not in json.dumps(await service.list(context))
    assert await service.sources[connection_id].call_tool(tool, {}, context) == {'ok': True}
    invocation = [params for method, params in runner.calls if method == 'invoke'][-1]
    assert invocation['credential']['kind'] == 'api_token'
    assert 'header' not in invocation['credential'] and 'scheme' not in invocation['credential']
    assert invocation['binding']['connection']['provider'] == provider
    assert invocation['binding']['connection']['config'] == {}
    assert not any(method.startswith('auth.') for method, _ in runner.calls)
    restarted = OfficialConnectors(service.runtime, runner=runner)
    await restarted.start()
    try:
        await restarted.attach_sources()
        source = restarted.sources[connection_id]
        assert await source.call_tool(tool, {}, context) == {'ok': True}
        await restarted.disconnect(context, connection_id)
        with pytest.raises(PermissionError):
            await source.call_tool(tool, {}, context)
    finally:
        await restarted.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('config', [{'origin': 'https://other.example'}, {'headers': {}}, {'workspace': 'other'}])
async def test_admitted_token_provider_rejects_arbitrary_connection_config(fixture, config):
    service, context, runner, _ = fixture
    original = runner.call

    async def catalog_call(method, params=None):
        if method == 'catalog':
            return await original(method, params) + [{
                'id': 'postman', 'name': 'Postman', 'auth': 'token', 'available': True,
                'provider': 'postman', 'capability': 'files',
            }]
        return await original(method, params)

    runner.call = catalog_call
    with pytest.raises(ValueError, match='configuration'):
        await service.create(context, {'catalog_id': 'postman', 'token': 'fixture-token', 'config': config})
    assert await service.list(context) == []
    assert not any(method == 'invoke' or method.startswith('auth.') for method, _ in runner.calls)
