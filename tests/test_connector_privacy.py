import asyncio
from dataclasses import replace
import hashlib
from pathlib import Path
from types import SimpleNamespace

import aiosqlite
import pytest

from openagent_core.content_privacy import ContentOrigin, ContentRevision
from openagent_storage_sqlite.content_privacy import SqliteContentPrivacyStore, REQUIRED_CONTENT_SURFACES
from openagent_server.connector_privacy import ConnectorPrivacyProcessor, grant_generation
from openagent_server.official_connectors import OfficialConnectors


class Allow:
    async def authorize(self,*args,**kwargs): return True


@pytest.mark.asyncio
async def test_real_receipt_durable_job_bridge_keeps_coverage_gate_closed(tmp_path):
    runtime=SimpleNamespace(agent=SimpleNamespace(name='QA',config={},memory_db=SimpleNamespace(db_path=tmp_path/'agent.sqlite')),authorizer=Allow())
    ledger=SqliteContentPrivacyStore(tmp_path/'privacy.sqlite')
    processor=ConnectorPrivacyProcessor(ledger)
    service=OfficialConnectors(runtime,privacy_processor=processor)
    await service.start()
    try:
        async with aiosqlite.connect(service.db_path) as db:
            await db.execute("INSERT INTO official_connector_connections(id,tenant_id,owner_key,catalog_id,provider,capability,display_name,status,app_id,group_id,created_at) VALUES('conn','tenant','owner','shopify','shopify','commerce','Shop','disconnected','app','group','2026-01-01T00:00:00Z')")
            await db.commit()
        receipt={'id':'verified-delivery','group':'group','topic':'customers/redact','created_at':'2026-10-13T12:00:00Z','occurred_at':'2026-10-13T11:00:00Z','receipt_version':2,'authorization_cutoff_at':'2026-10-13T11:00:00Z','payload':{'shop_id':1,'customer':{'id':23},'orders_to_redact':[42]}}
        origin=ContentOrigin('tenant','shopify/app','group',grant_generation('2026-10-13T10:00:00Z'),('customer:23',))
        revision=ContentRevision('tenant','result','v1','sink',hashlib.sha256(b'private').hexdigest())
        await ledger.record(revision,origins=(origin,))
        await service.receive_event(receipt)
        await service.process_privacy_events()
        async with aiosqlite.connect(service.db_path) as db:
            row=await (await db.execute('SELECT status,ciphertext FROM official_connector_events')).fetchone()
        assert row[0]=='blocked'
        assert b'customer' not in row[1]
        assert service.authorization_available('shopify') is False
        completed=[]
        class Sink:
            sink_id='sink'
            async def apply(self,request,revision):
                completed.append((request,revision))
                return 'complete'
        # Explicit test-only full coverage attestation; no product runtime sets it.
        processor.sinks=(Sink(),)
        processor.covered_surfaces=REQUIRED_CONTENT_SURFACES
        await service.process_privacy_events()
        assert len(completed)==1
        assert completed[0][0].subjects==('customer:23','order:42')
        assert completed[0][0].through_generation==grant_generation(receipt['occurred_at'])
        await service.process_privacy_events()
        assert len(completed)==1
        async with aiosqlite.connect(service.db_path) as db:
            assert (await (await db.execute('SELECT status FROM official_connector_events')).fetchone())[0]=='complete'
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_missing_recipient_and_wrong_customer_identity_are_not_completion(tmp_path):
    store=SqliteContentPrivacyStore(tmp_path/'privacy.sqlite')
    processor=ConnectorPrivacyProcessor(store,covered_surfaces=REQUIRED_CONTENT_SURFACES)
    receipt={'id':'event','group':'group','topic':'customers/data_request','occurred_at':'2026-10-13T11:00:00Z','receipt_version':2,'authorization_cutoff_at':'2026-10-13T11:00:00Z','payload':{'customer':{'id':23}}}
    assert await processor.process(receipt,[])=='blocked'
    receipt['payload']['customer']['id']=True
    with pytest.raises(ValueError):
        await processor.process(receipt,[{'tenant_id':'tenant','provider':'shopify','app_id':'app','group_id':'group'}])


@pytest.mark.asyncio
async def test_uninstall_does_not_fabricate_data_redaction_completion(tmp_path):
    store=SqliteContentPrivacyStore(tmp_path/'privacy.sqlite')
    processor=ConnectorPrivacyProcessor(store)
    assert await processor.process({'topic':'app/uninstalled','receipt_version':2,
        'occurred_at':'2026-10-13T11:00:00Z','authorization_cutoff_at':'2026-10-13T11:00:00Z'},[])=='credential_revoked'

@pytest.mark.asyncio
async def test_legacy_receipt_and_processor_failure_remain_retryable(tmp_path):
    runtime=SimpleNamespace(agent=SimpleNamespace(name='QA',config={},memory_db=SimpleNamespace(db_path=tmp_path/'agent.sqlite')),authorizer=Allow())
    seen=[]
    class Processor:
        fail=True
        async def process(self,receipt,connections):
            seen.append(receipt['id'])
            if self.fail:
                raise RuntimeError('PRIVATE FAILURE CONTENT')
            return 'complete'
    processor=Processor()
    service=OfficialConnectors(runtime,privacy_processor=processor)
    await service.start()
    try:
        await service.receive_event({'id':'event','group':'group','topic':'shop/redact','created_at':'2026-10-15T12:00:00Z',
            'receipt_version':2,'occurred_at':'2026-10-15T12:00:00Z',
            'authorization_cutoff_at':'2026-10-13T11:00:00Z','uninstall_event_id':'a'*64,'payload':{'shop_id':23}})
        await service.process_privacy_events()
        processor.fail=False
        await service.process_privacy_events()
        async with aiosqlite.connect(service.db_path) as db:
            assert (await (await db.execute('SELECT status FROM official_connector_events')).fetchone())[0]=='complete'
            await db.execute("UPDATE official_connector_events SET receipt_format=1,status='pending'")
            await db.commit()
        await service.process_privacy_events()
        assert len(seen)==2
        async with aiosqlite.connect(service.db_path) as db:
            assert (await (await db.execute('SELECT status FROM official_connector_events')).fetchone())[0]=='blocked'
        assert b'PRIVATE FAILURE CONTENT' not in service.db_path.read_bytes()
    finally:
        await service.close()
