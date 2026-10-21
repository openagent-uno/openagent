"""A Scheduler-claimed event delivery keeps its lease for the whole dispatch.

The drain stamps ``claim_expires = now + LEASE_TTL`` when it claims a
delivery, and ``reap_expired_event_leases`` re-enqueues any row whose lease
lapsed. ``AutomationExecution.run_event`` must beat that lease from the claim
until the Runtime record is observed; otherwise a healthy turn longer than the
lease is reaped mid-run and its replay reuses the deterministic run ID.
"""

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest import mock

from openagent_core import Runtime, RuntimeServices, RuntimeSettings
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_core.core.event_dispatcher import dispatch_event
from openagent_core.engine import MemoryDB
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.automation_authority import NativeAutomationAuthority
from openagent_server.automation_execution import NativeAutomationExecution
from openagent_server.automation_management import NativeAutomationManagement

LEASE_TTL_SECONDS = 3.0
RUN_SECONDS = 2.5 * LEASE_TTL_SECONDS


class Policy:
    async def authorize(self, context, action, resource, *, audience=()):
        return not (context.deferred and action.startswith("automation."))


class Executor:
    async def execute(self, request, context, runtime):
        return "agent response"


class EventLeaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # A short lease for the claim and the beat; the Runtime environment is
        # left at its default, as an embedding host may do.
        self.environment = mock.patch.dict(
            os.environ, {"OPENAGENT_EVENT_LEASE_TTL_SECONDS": str(LEASE_TTL_SECONDS)}
        )
        self.environment.start()
        self.temp = tempfile.TemporaryDirectory()
        path = Path(self.temp.name) / "state.sqlite3"
        self.db = MemoryDB(db_path=str(path))
        await self.db.connect()

        async def active(principal):
            return True

        self.agent = SimpleNamespace(memory_db=self.db, name="agent", config={})
        self.service = SimpleNamespace(
            agent=self.agent, authorizer=Policy(),
            gateway=SimpleNamespace(runtime_principal_active=active),
        )
        self.service.automations = NativeAutomationAuthority(self.service)
        await self.service.automations.start()
        self.runtime = Runtime(
            RuntimeSettings("agent", path.parent),
            RuntimeServices(SqliteRuntimeStore(path), Executor(), Policy(),
                            delegations=self.service.automations),
        )
        self.service.runtime = self.runtime
        self.management = NativeAutomationManagement(self.service)
        self.service.automation_management = self.management
        self.execution = NativeAutomationExecution(self.service)
        await self.runtime.start()
        owner = PrincipalRef("openagent", "network", "alice")
        context = ExecutionContext(owner, owner, owner, "session", "agent", (owner,), ingress_id="trusted")
        self.event_id = await self.management.mutate(
            "event",
            lambda store: store.add_event(
                name="Inbound", slug="inbound", action_kind="prompt",
                prompt_template="handle it", secret_enc="encrypted-placeholder",
            ),
            context,
        )
        self.delivery_id = await self.db.add_event_delivery(
            event_id=self.event_id, source="agent", payload={}, claimed=False,
        )
        [claimed] = await self.db.claim_pending_event_deliveries(definition_ids=(self.event_id,))
        self.assertEqual(claimed["id"], self.delivery_id)
        self.assertIsNotNone(claimed["claim_expires"])
        self.reaped = 0

    async def asyncTearDown(self):
        await self.runtime.close()
        await self.db.close()
        self.temp.cleanup()
        self.environment.stop()

    async def _reap_continuously(self):
        while True:
            self.reaped += await self.db.reap_expired_event_leases()
            await asyncio.sleep(0.25)

    async def _dispatch_with_reaper(self, coroutine):
        reaper = asyncio.create_task(self._reap_continuously())
        try:
            return await coroutine
        finally:
            reaper.cancel()
            await asyncio.gather(reaper, return_exceptions=True)

    async def _assert_lease_kept(self):
        row = await self.db.get_event_delivery(self.delivery_id)
        self.assertEqual(self.reaped, 0)
        self.assertEqual(row["reenqueue_count"], 0)
        self.assertIsNotNone(row["claimed_at"])
        self.assertIsNotNone(row["last_heartbeat_at"])
        return row

    async def test_long_dispatch_window_keeps_the_claim_lease(self):
        """Any part of run_event longer than the lease is covered by its beat."""
        event = await self.db.get_event(self.event_id)

        async def long_execute(**kwargs):
            await asyncio.sleep(RUN_SECONDS)
            await self.db.update_event_delivery(
                kwargs["delivery_id"], status="success", finished_at=time.time(),
            )
            return {"status": "success"}

        started = time.monotonic()
        result = await self._dispatch_with_reaper(self.execution.run_event(
            agent=self.agent, db=self.db, scheduler=SimpleNamespace(db=self.db),
            event=event, payload={}, delivery_id=self.delivery_id, source="agent",
            broadcast=None, execute=long_execute,
        ))
        self.assertGreater(time.monotonic() - started, RUN_SECONDS)
        self.assertEqual(result, {"status": "success"})
        row = await self._assert_lease_kept()
        self.assertEqual(row["status"], "success")

        # The beat ends with the dispatch instead of leaking past it.
        last_beat = row["last_heartbeat_at"]
        await asyncio.sleep(2.0)
        self.assertEqual((await self.db.get_event_delivery(self.delivery_id))["last_heartbeat_at"], last_beat)

    async def test_long_prompt_turn_through_core_dispatch_is_not_reaped(self):
        """The production entry point: Core dispatch_event -> run_event."""
        async def handler(**kwargs):
            await asyncio.sleep(RUN_SECONDS)
            return SimpleNamespace(session_id=kwargs["session_id"], text="done", failed=False)

        self.agent.extensions = SimpleNamespace(event_handler=handler, execution_profile_selector=None)
        event = await self.db.get_event(self.event_id)
        result = await self._dispatch_with_reaper(dispatch_event(
            agent=self.agent, db=self.db,
            scheduler=SimpleNamespace(db=self.db, execution_service=self.execution),
            event=event, payload={}, delivery_id=self.delivery_id, source="agent",
        ))
        self.assertEqual(result["status"], "success")
        row = await self._assert_lease_kept()
        self.assertEqual(row["status"], "success")


if __name__ == "__main__":
    unittest.main()
