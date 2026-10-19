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
            "created_at": "2026-10-13T09:00:00Z", "occurred_at": "2026-10-12T09:00:00Z",
            "receipt_version": 2, "authorization_cutoff_at": "2026-10-12T09:00:00Z", **changes}


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
    {"group": "another-shop-group"},
    {"occurred_at": "2026-10-13T10:00:00Z", "authorization_cutoff_at": "2026-10-13T10:00:00Z"}, {"payload": {"shop_id": 999}},
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


async def install_consent_versions(service):
    for connection, authorized in [("old", "2026-10-11T09:00:00Z"), ("new", "2026-10-13T09:00:00Z")]:
        async with aiosqlite.connect(service.db_path) as db:
            await db.execute("""INSERT INTO official_connector_connections
                (id,tenant_id,owner_key,catalog_id,provider,capability,display_name,status,group_id,created_at)
                VALUES(?,'tenant','owner','shopify','shopify','commerce',?,'pending','group-fixture','2026-10-11T09:00:00Z')""", (connection, connection))
            await db.commit()
        # Save through the same encrypted host path, with a distinct generation.
        await service.save(await service.record(connection), {"access_token": "private-test-token", "app_id": "shopify-test-app",
                           "group": "group-fixture", "authorized_at": authorized, "scopes": []})


@pytest.mark.asyncio
async def test_old_uninstall_does_not_revoke_a_new_consent_but_revokes_old_credential(service):
    await install_consent_versions(service)
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
                assert params == {"receipt_version": 2}
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
async def test_revoked_publication_cannot_starve_uninstall_receipt_or_local_work(service):
    await install_consent_versions(service)
    calls = []

    class Processor:
        async def process(self, incoming, connections):
            calls.append("process")
            assert incoming == event(topic="app/uninstalled")
            assert (await service.record("old"))["credential"] is None
            return "credential_revoked"

    class Delivery:
        async def close(self):
            pass

        async def call(self, method, params=None):
            calls.append(method)
            if method == "events":
                assert params == {"receipt_version": 2}
                return [event(topic="app/uninstalled")]
            if method == "events.ack":
                assert (await receipt(service))["receipt_format"] == 2
                assert (await service.record("old"))["credential"] is None
            if method == "sync.mail":
                return {}
            if method == "auth.publish":
                # Reloading rows after receipt processing excludes the revoked
                # old credential but preserves a genuinely later consent.
                assert params["token"]["authorized_at"] == "2026-10-13T09:00:00Z"
                raise RuntimeError("designed revoked publication")
            if method == "sync.recover":
                raise RuntimeError("designed recovery not found")

    service.runner, service.privacy_processor = Delivery(), Processor()
    with pytest.raises(RuntimeError, match="Connector credential synchronization is incomplete"):
        await service.synchronize()
    assert calls[:4] == ["events", "events.ack", "process", "sync.mail"]
    assert calls[4:] == ["auth.publish", "sync.recover"]
    assert (await receipt(service))["status"] == "credential_revoked"
    assert service.decrypt(await service.record("new"))["access_token"] == "private-test-token"


@pytest.mark.asyncio
async def test_one_failed_binding_publication_and_recovery_do_not_skip_other_bindings(service):
    await install_consent_versions(service)
    publications, recoveries = [], []

    class Delivery:
        async def close(self):
            pass

        async def call(self, method, params=None):
            if method == "events":
                return [event()]
            if method == "events.ack":
                assert (await receipt(service))["receipt_format"] == 2
            if method == "sync.mail":
                return {}
            if method == "auth.publish":
                publications.append(params["token"]["authorized_at"])
                if params["token"]["authorized_at"] == "2026-10-11T09:00:00Z":
                    raise RuntimeError("designed unavailable binding")
            if method == "sync.recover":
                recoveries.append(params["group"])
                raise RuntimeError("designed missing recovery")

    service.runner = Delivery()
    with pytest.raises(RuntimeError, match="Connector credential synchronization is incomplete"):
        await service.synchronize()
    assert set(publications) == {"2026-10-11T09:00:00Z", "2026-10-13T09:00:00Z"}
    assert recoveries == ["group-fixture"]
    assert (await receipt(service))["status"] == "pending"
    for key in ("old", "new"):
        assert (await service.record(key))["credential"] is not None


@pytest.mark.asyncio
async def test_invalid_receipt_is_not_acked_and_does_not_starve_next_durable_receipt(service):
    acknowledgments = []

    class Delivery:
        async def close(self):
            pass

        async def call(self, method, params=None):
            if method == "events":
                return [event(id="invalid", authorization_cutoff_at=None), event()]
            if method == "events.ack":
                assert (await receipt(service))["id"] == params["id"]
                acknowledgments.append(params["id"])
                return {}
            pytest.fail("Receipt failure must remain visible before credential synchronization")

    service.runner = Delivery()
    with pytest.raises(ValueError):
        await service.synchronize()
    assert acknowledgments == ["event-fixture"]
    assert (await receipt(service))["status"] == "pending"


@pytest.mark.asyncio
async def test_broker_delivery_outage_still_processes_previously_committed_receipt(service):
    await service.receive_event(event())

    class Processor:
        async def process(self, incoming, connections):
            assert incoming == event()
            return "complete"

    class Delivery:
        async def close(self):
            pass

        async def call(self, method, params=None):
            assert method == "events"
            raise RuntimeError("designed broker outage")

    service.runner, service.privacy_processor = Delivery(), Processor()
    with pytest.raises(RuntimeError, match="designed broker outage"):
        await service.synchronize()
    assert (await receipt(service))["status"] == "complete"


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


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [
    {"receipt_version": None}, {"receipt_version": 1}, {"receipt_version": True},
    {"authorization_cutoff_at": None}, {"occurred_at": None},
    {"authorization_cutoff_at": "2026-10-11T09:00:00Z"},
    {"authorization_cutoff_at": "2026-10-12T09:00:00+01:00"},
    {"uninstall_event_id": "a" * 64},
    {"topic": "shop/redact"},
    {"topic": "shop/redact", "uninstall_event_id": "not-an-event-id"},
    {"topic": "shop/redact", "uninstall_event_id": "a" * 64},
    {"unexpected_cutoff": "2026-10-12T09:00:00Z"},
    {"id": "a" * 64, "topic": "shop/redact", "uninstall_event_id": "a" * 64,
     "occurred_at": "2026-10-15T09:00:00Z"},
    {"occurred_at": "1960-10-12T09:00:00Z", "authorization_cutoff_at": "1960-10-12T09:00:00Z"},
])
async def test_incomplete_or_inconsistent_v2_is_not_persisted(service, changes):
    with pytest.raises(ValueError):
        await service.receive_event(event(**changes))
    async with aiosqlite.connect(service.db_path) as db:
        assert (await (await db.execute("SELECT COUNT(*) FROM official_connector_events")).fetchone())[0] == 0


@pytest.mark.asyncio
async def test_delayed_shop_redact_keeps_new_consent_across_out_of_order_redelivery_and_restart(service):
    # Reuse the encrypted credential fixture, then deliver redaction after a
    # newer consent. Original notification time is deliberately newer than it.
    await install_consent_versions(service)
    delayed = event(id="delayed-redact", topic="shop/redact",
                    created_at="2026-10-15T12:00:00Z", occurred_at="2026-10-15T11:00:00Z",
                    authorization_cutoff_at="2026-10-12T09:00:00Z", uninstall_event_id="a" * 64)
    await service.receive_event(delayed)
    assert (await service.record("old"))["credential"] is None
    current = await service.record("new")
    assert current["enabled"] == 1 and service.decrypt(current)["access_token"] == "private-test-token"
    restarted = OfficialConnectors(service.runtime)
    restarted.runner = None
    await restarted.start()
    try:
        await restarted.receive_event(delayed)
        # An even older uninstall delivered after redaction cannot clear the
        # newer credential; event ordering does not replace consent identity.
        await restarted.receive_event(event(id="older-uninstall", topic="app/uninstalled"))
        assert restarted.decrypt(await restarted.record("new"))["access_token"] == "private-test-token"
        async with aiosqlite.connect(restarted.db_path) as db:
            db.row_factory = aiosqlite.Row
            row = dict(await (await db.execute("SELECT * FROM official_connector_events WHERE id='delayed-redact'")).fetchone())
        stored = json.loads(AESGCM(restarted.key).decrypt(row["nonce"], row["ciphertext"], row["id"].encode()))
        assert stored == delayed
        for changed in ({"uninstall_event_id": "b" * 64},
                        {"authorization_cutoff_at": "2026-10-12T08:00:00Z"},
                        {"occurred_at": "2026-10-15T12:00:00Z"}):
            with pytest.raises(ValueError, match="conflicts"):
                await restarted.receive_event({**delayed, **changed})
        assert restarted.decrypt(await restarted.record("new"))["access_token"] == "private-test-token"
    finally:
        await restarted.close()


@pytest.mark.asyncio
async def test_legacy_full_receipt_without_cutoff_remains_blocked_after_restart(service):
    incoming = event()
    del incoming["receipt_version"], incoming["authorization_cutoff_at"]
    nonce = b"0123456789ab"
    ciphertext = AESGCM(service.key).encrypt(nonce, json.dumps(incoming).encode(), incoming["id"].encode())
    async with aiosqlite.connect(service.db_path) as db:
        await db.execute("INSERT INTO official_connector_events(id,group_id,topic,ciphertext,nonce,received_at,receipt_format) VALUES(?,?,?,?,?,?,2)",
                         (incoming["id"], incoming["group"], incoming["topic"], ciphertext, nonce, incoming["created_at"]))
        await db.commit()
    class UnexpectedProcessor:
        async def process(self, *_):
            pytest.fail("A legacy receipt must not reach a privacy processor without its authenticated cutoff")
    restarted = OfficialConnectors(service.runtime, privacy_processor=UnexpectedProcessor())
    restarted.runner = None
    await restarted.start()
    try:
        await restarted.process_privacy_events()
        stored = await receipt(restarted)
        assert stored["status"] == "blocked" and stored["ciphertext"] == ciphertext
        with pytest.raises(ValueError, match="conflicts"):
            await restarted.receive_event(event())
    finally:
        await restarted.close()
