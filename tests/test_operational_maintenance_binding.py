"""The standalone gateway maps the public Core worker into REST readiness."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from openagent_core.memory.operational.maintenance import OperationalMaintenanceStatus
from openagent_server.gateway.api.operational import _background_bootstrap


class OperationalMaintenanceBindingTests(unittest.IsolatedAsyncioTestCase):
    async def test_ready_degraded_and_recovered_status_follow_the_core_worker(self):
        gateway = SimpleNamespace()
        database = object()
        async def worker(db, notify):
            self.assertIs(db, database)
            notify(OperationalMaintenanceStatus(True, {'ready': True, 'seq': 7}))
            self.assertTrue(gateway._operational_ready_event.is_set())
            self.assertTrue(gateway._operational_history_ready)
            notify(OperationalMaintenanceStatus(False, {'ready': False}, failed=True))
            self.assertFalse(gateway._operational_ready_event.is_set())
            self.assertTrue(gateway._operational_bootstrap_error)
            notify(OperationalMaintenanceStatus(True, {'ready': True, 'seq': 8}))
        with patch('openagent_core.memory.operational.maintenance.maintain_operational_storage', side_effect=worker):
            await _background_bootstrap(gateway, database)
        self.assertEqual(gateway._operational_search_status['seq'], 8)
        self.assertTrue(gateway._operational_ready_event.is_set())
        self.assertFalse(gateway._operational_bootstrap_error)

    async def test_gateway_cancellation_reaches_the_core_owner(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()
        async def worker(db, notify):
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        with patch('openagent_core.memory.operational.maintenance.maintain_operational_storage', side_effect=worker):
            task = asyncio.create_task(_background_bootstrap(SimpleNamespace(), object()))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(cancelled.is_set())


if __name__ == '__main__':
    unittest.main()
