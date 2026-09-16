"""A standalone support replay must use the public catalog and temporary store."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'apps/server'))
from scripts.tests._support_runtime import fixture_runtime
from scripts.tests.test_local_support_controller import _Doubles
from openagent_core.engine import call_tool
from openagent_core.runtime import current_runtime


class SupportReplayRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_replay_dispatches_registered_fixture_through_runtime(self):
        @fixture_runtime
        async def replay():
            doubles = _Doubles(thread={'product': 'esound', 'messages': []})
            pool = doubles.pool()
            result = await call_tool(pool, 'replio', 'replio_threads_get', {'thread_id': 'synthetic'})
            self.assertIn('replio_threads_get', doubles.names)
            runtime = current_runtime()
            self.assertIsNotNone(runtime)
            return result

        self.assertIsNotNone(await replay())
        self.assertIsNone(current_runtime())

    async def test_replay_propagates_original_failure_and_closes_runtime(self):
        @fixture_runtime
        async def replay():
            raise ValueError('synthetic replay failure')

        with self.assertRaisesRegex(ValueError, 'synthetic replay failure'):
            await replay()
        self.assertIsNone(current_runtime())
