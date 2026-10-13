import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

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
                    {"id": "clickup", "name": "ClickUp", "auth": "oauth", "available": True, "provider": "clickup", "capability": "files"}]
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
