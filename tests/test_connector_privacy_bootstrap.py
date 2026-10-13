"""Normal product startup installs opt-in services before any source attachment."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from openagent_core.content_privacy import ToolResultPrivacyPublisher, EngineContentPrivacyWriter, SessionJournalPrivacyWriter
from openagent_server.runtime_service import NativeRuntimeService
from openagent_storage_sqlite import SqliteRuntimeStore
from test_runtime_service import FakeAgent


class PrivacyBootstrap(unittest.IsolatedAsyncioTestCase):
    async def test_known_fresh_assembly_delivers_owner_reply_and_purges_revoked_pending_output(self):
        import asyncio
        import aiosqlite
        from openagent_core import RunRequest
        from openagent_core.engine import MemoryDB, NativeProvider
        from openagent_core.extensions import EngineExtensions
        from openagent_core.runtime import execution_scope
        from openagent_core.content_privacy import PrivacyRequest, PrivacyFence
        from openagent_core.stream.session import StreamSession
        from openagent_core.stream.channel import RealtimeChannel
        from openagent_core.stream.events import OutTextFinal, OutTextDelta
        from openagent_client_transport.stream.wire import event_to_wire, wire_to_event
        from openagent_server.bootstrap import start_stream
        from test_runtime_access import Request
        from test_connector_provenance import ProviderFixture
        from openagent_server.connector_privacy import grant_generation
        with tempfile.TemporaryDirectory() as directory:
            agent = FakeAgent(Path(directory)/'state.sqlite')
            memory = MemoryDB(agent.memory_db.db_path)
            await memory.connect()
            agent.memory_db = memory
            agent.model = NativeProvider('openai:fixture', api_key='fixture')
            agent.extensions = EngineExtensions()
            agent.config['connectors'] = {'privacy':{'enabled':True}}
            async def authorized(*args): return True
            gateway = SimpleNamespace(agent=agent, _request_device_still_authorized=authorized)
            service = NativeRuntimeService(gateway, agent)
            gateway.runtime_service = service
            service.official_connectors.runner = None
            stream, channel = None, None
            try:
                await service.start()
                processor = service.official_connectors.privacy_processor
                self.assertEqual(processor.covered_surfaces, processor.store.required_surfaces)
                self.assertFalse(service.official_connectors.authorization_available('shopify'))
                identity = await service.authorizer.bind_request(Request(gateway, 'owner'))
                context = await service.authorizer.context_for_identity(identity, 'managed')
                service.official_connectors.runner = ProviderFixture()
                async with aiosqlite.connect(service.official_connectors.db_path) as db:
                    await db.execute('''INSERT INTO official_connector_connections
                        (id,tenant_id,owner_key,catalog_id,provider,capability,display_name,status,created_at)
                        VALUES('connection',?,?,'shopify','shopify','commerce','Shop','pending','2026-10-13T10:00:00Z')''',
                        (context.tenant_id, context.initiator.key))
                    await db.commit()
                await service.official_connectors.save(await service.official_connectors.record('connection'),
                    {'access_token':'synthetic-fixture','app_id':'app','group':'group',
                     'authorized_at':'2026-10-13T10:00:00Z','version':1})
                await service.store.accept(RunRequest('managed-run','managed','managed-key','HUMAN INPUT'),context)
                await service.store.transition('managed-run','running')
                stream = StreamSession(service.facade, client_id='owner', session_id='managed', speak_enabled=False)
                with patch('openagent_server.audio_service.service_for_gateway', return_value=SimpleNamespace()):
                    await start_stream(stream, gateway)
                self.assertIn(stream, processor.streams)
                delivered, cache = [], []
                sent = asyncio.Event()
                async def sender(payload):
                    delivered.append(payload)
                    sent.set()
                    return True
                channel = RealtimeChannel(stream, sender, encoder=event_to_wire, decoder=wire_to_event,
                                          on_outbound=cache.append)
                tools = {item.name:item.tool_ref for item in await service.runtime.capabilities.discover(context)}
                reference = tools['commerce.shopify.customers.get']
                with execution_scope(service.runtime,context,'managed-run'):
                    result = await service.runtime.capabilities.call_tool(reference,{'id':'gid://shopify/Customer/23'},context)
                    await stream._publish(OutTextFinal(text=result['data']['customer']['name']))
                await channel.start()
                await asyncio.wait_for(sent.wait(), 2)
                self.assertTrue(any(frame.get('text')=='PROVIDER CUSTOMER' for frame in delivered))
                self.assertEqual(cache, [])
                # Keep a second matching frame pending, then use the real host
                # prepare callback after its durable admission fence.
                channel._pump_task.cancel()
                await channel._pump_task
                with execution_scope(service.runtime,context,'managed-run'):
                    await stream._publish(OutTextDelta(text='PENDING PRIVATE REPLY'))
                await stream._publish(OutTextDelta(text='UNRELATED HUMAN FRAME'))
                request = PrivacyRequest('actual-redact',context.tenant_id,'shopify/app','group',
                    grant_generation('2026-10-13T10:00:00Z'),'redact',('customer:23',))
                await processor.store.enqueue(request)
                await processor.prepare(request)
                self.assertEqual(stream.outbound.qsize(), 1)
                self.assertEqual((await stream.outbound.get()).text, 'UNRELATED HUMAN FRAME')
                with execution_scope(service.runtime,context,'managed-run'), self.assertRaises(PrivacyFence):
                    await stream._publish(OutTextDelta(text='LATE PRIVATE REPLY'))
                progress = await processor.store.process(request.request_id,processor.sinks,
                                                         covered_surfaces=processor.covered_surfaces)
                self.assertEqual(progress.status, 'complete')
                self.assertNotIn('PROVIDER CUSTOMER', str(await memory.list_session_events('managed')))
            finally:
                if channel is not None: await channel.close()
                elif stream is not None: await stream.close()
                await service.close()
                await memory.close()

    async def test_normal_start_installs_public_services_before_sources_without_self_attested_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = FakeAgent(Path(directory)/'state.sqlite')
            agent.config['connectors'] = {'privacy':{'enabled':True}, 'official_providers':['shopify']}
            seed = SqliteRuntimeStore(agent.memory_db.db_path)
            await seed.start()
            await seed.close()
            service = NativeRuntimeService(SimpleNamespace(agent=agent), agent)
            service.official_connectors.runner = None
            observed = []
            async def attach():
                for contract in (ToolResultPrivacyPublisher, EngineContentPrivacyWriter, SessionJournalPrivacyWriter):
                    observed.append(service.runtime.service(contract))
            try:
                with patch.object(service.official_connectors, 'attach_sources', side_effect=attach):
                    await service.start()
                self.assertTrue(all(observed))
                self.assertEqual(len(observed), 3)
                self.assertEqual(service.official_connectors.privacy_processor.covered_surfaces, frozenset())
                self.assertFalse(service.official_connectors.authorization_available('shopify'))
            finally:
                await service.close()

    async def test_config_cannot_claim_coverage_or_accept_truthy_nonboolean(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = FakeAgent(Path(directory)/'state.sqlite')
            service = NativeRuntimeService(SimpleNamespace(agent=agent), agent)
            for value in ({'enabled':True,'covered_surfaces':['all']}, {'enabled':'true'}, True, {}):
                agent.config['connectors'] = {'privacy':value}
                with self.subTest(value=value), self.assertRaises(ValueError):
                    service.official_connectors.privacy_enabled()
            agent.config['connectors'] = {'privacy':{'enabled':False}}
            self.assertFalse(service.official_connectors.privacy_enabled())
