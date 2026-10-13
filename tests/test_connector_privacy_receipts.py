import asyncio
import json
from types import SimpleNamespace

import aiosqlite
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import pytest

from openagent_server.official_connectors import OfficialConnectors


@pytest.fixture
async def service(tmp_path):
    runtime = SimpleNamespace(agent=SimpleNamespace(name="Privacy receipt QA", config={},
                              memory_db=SimpleNamespace(db_path=tmp_path / "agent.sqlite")))
    result = OfficialConnectors(runtime)
    # Receipt persistence does not require a runner or a provider credential.
    result.runner = None
    await result.start()
    yield result
    await result.close()


def event(**changes):
    return {"id": "event-fixture", "group": "group-fixture", "topic": "customers/redact",
            "payload": {"shop_id": 123, "customer": {"id": 456}},
            "created_at": "2026-10-13T09:00:00Z", "occurred_at": "2026-10-12T09:00:00Z", **changes}


async def receipt(service):
    async with aiosqlite.connect(service.db_path) as db:
        db.row_factory = aiosqlite.Row
        rows = await (await db.execute("SELECT * FROM official_connector_events")).fetchall()
        assert len(rows) == 1
        return dict(rows[0])


@pytest.mark.asyncio
async def test_receipt_retains_encrypted_origin_occurrence_and_pending_state(service):
    incoming = event(payload={"shop_id": 123, "customer": {"id": 456, "email": "private-customer@example.invalid"}})
    await service.receive_event(incoming)
    row = await receipt(service)
    assert row["receipt_format"] == 2 and row["status"] == "pending"
    assert b"private-customer" not in row["ciphertext"]
    assert json.loads(AESGCM(service.key).decrypt(row["nonce"], row["ciphertext"], row["id"].encode())) == incoming
    # A complete receipt survives an independent host restart and matching key.
    restarted = OfficialConnectors(service.runtime)
    restarted.runner = None
    await restarted.start()
    try:
        restored = await receipt(restarted)
        assert restored == row
        assert json.loads(AESGCM(restarted.key).decrypt(restored["nonce"], restored["ciphertext"], restored["id"].encode())) == incoming
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_concurrent_redelivery_is_deduplicated_without_overwriting_status(service):
    await service.receive_event(event())
    async with aiosqlite.connect(service.db_path) as db:
        await db.execute("UPDATE official_connector_events SET status='processing'")
        await db.commit()
    original = await receipt(service)
    await asyncio.gather(*(service.receive_event(event()) for _ in range(4)))
    assert await receipt(service) == original


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [
    {"group": "another-shop-group"}, {"topic": "shop/redact"},
    {"occurred_at": "2026-10-13T10:00:00Z"}, {"payload": {"shop_id": 999}},
])
async def test_conflicting_duplicate_cannot_replace_a_committed_receipt(service, changes):
    await service.receive_event(event())
    original = await receipt(service)
    with pytest.raises(ValueError, match="conflicts"):
        await service.receive_event(event(**changes))
    assert await receipt(service) == original


@pytest.mark.asyncio
async def test_payload_only_legacy_receipt_is_enriched_only_by_matching_redelivery(service):
    incoming = event()
    nonce = b"0123456789ab"
    ciphertext = AESGCM(service.key).encrypt(nonce, json.dumps(incoming["payload"]).encode(), incoming["id"].encode())
    async with aiosqlite.connect(service.db_path) as db:
        await db.execute("INSERT INTO official_connector_events(id,group_id,topic,ciphertext,nonce,received_at,status) VALUES(?,?,?,?,?,?,?)",
                         (incoming["id"], incoming["group"], incoming["topic"], ciphertext, nonce, "2026-10-13T09:01:00Z", "pending"))
        await db.commit()
    original = await receipt(service)
    assert original["receipt_format"] == 1
    with pytest.raises(ValueError, match="conflicts"):
        await service.receive_event(event(payload={"shop_id": 999}))
    assert await receipt(service) == original
    await service.receive_event(incoming)
    row = await receipt(service)
    assert row["receipt_format"] == 2 and row["received_at"] == original["received_at"]
    assert row["status"] == "pending"
    assert json.loads(AESGCM(service.key).decrypt(row["nonce"], row["ciphertext"], row["id"].encode())) == incoming


@pytest.mark.asyncio
async def test_old_uninstall_does_not_revoke_a_new_consent_but_revokes_old_credential(service):
    for connection, authorized in [("old", "2026-10-11T09:00:00Z"), ("new", "2026-10-13T09:00:00Z")]:
        async with aiosqlite.connect(service.db_path) as db:
            await db.execute("""INSERT INTO official_connector_connections
                (id,tenant_id,owner_key,catalog_id,provider,capability,display_name,status,group_id,created_at)
                VALUES(?,'tenant','owner','shopify','shopify','commerce',?,'pending','group-fixture','2026-10-11T09:00:00Z')""", (connection, connection))
            await db.commit()
        # Save through the same encrypted host path, with a distinct generation.
        await service.save(await service.record(connection), {"access_token": "private-test-token", "app_id": "shopify-test-app",
                           "group": "group-fixture", "authorized_at": authorized, "scopes": []})
    incoming = event(topic="app/uninstalled")
    await service.receive_event(incoming)
    assert (await service.record("old"))["credential"] is None
    current = await service.record("new")
    assert service.decrypt(current)["access_token"] == "private-test-token"
    assert current["enabled"] == 1
    await service.receive_event(incoming)
    assert service.decrypt(await service.record("new"))["access_token"] == "private-test-token"


@pytest.mark.asyncio
async def test_lost_delivery_ack_retries_only_after_the_receipt_is_durable(service):
    class Delivery:
        failed_ack = True
        acknowledgments = 0

        async def call(self, method, params=None):
            if method == "sync.mail":
                return {}
            if method == "events":
                return [event()]
            if method == "events.ack":
                # Observe through an independent connection, as a restarted
                # process would; an uncommitted row must not count as receipt.
                row = await receipt(service)
                assert row["receipt_format"] == 2 and row["status"] == "pending"
                self.acknowledgments += 1
                if self.failed_ack:
                    raise RuntimeError("simulated response loss")

    delivery = Delivery()
    service.runner = delivery
    with pytest.raises(RuntimeError, match="simulated"):
        await service.synchronize()
    original = await receipt(service)
    delivery.failed_ack = False
    await service.synchronize()
    assert delivery.acknowledgments == 2
    assert await receipt(service) == original
    service.runner = None


@pytest.mark.asyncio
async def test_historical_schema_upgrade_does_not_invent_occurrence_metadata(tmp_path):
    database = tmp_path / "agent.sqlite"
    key = AESGCM.generate_key(bit_length=256)
    (tmp_path / "connector-credential-key").write_bytes(key)
    incoming = event()
    nonce = b"0123456789ab"
    ciphertext = AESGCM(key).encrypt(nonce, json.dumps(incoming["payload"]).encode(), incoming["id"].encode())
    async with aiosqlite.connect(database) as db:
        await db.execute("""CREATE TABLE official_connector_events (
            id TEXT PRIMARY KEY, group_id TEXT NOT NULL, topic TEXT NOT NULL,
            ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, received_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending')""")
        await db.execute("INSERT INTO official_connector_events VALUES(?,?,?,?,?,?,'pending')",
                         (incoming["id"], incoming["group"], incoming["topic"], ciphertext, nonce, "2026-10-13T09:01:00Z"))
        await db.commit()
    runtime = SimpleNamespace(agent=SimpleNamespace(name="Legacy QA", config={}, memory_db=SimpleNamespace(db_path=database)))
    service = OfficialConnectors(runtime)
    service.runner = None
    await service.start()
    try:
        row = await receipt(service)
        assert row["receipt_format"] == 1 and row["ciphertext"] == ciphertext
        assert json.loads(AESGCM(key).decrypt(row["nonce"], row["ciphertext"], row["id"].encode())) == incoming["payload"]
        # Repeated startup migrates once and leaves the historical data intact.
        await service.start()
        assert await receipt(service) == row
    finally:
        await service.close()
