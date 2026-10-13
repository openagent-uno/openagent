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
