"""A device its owner lent to one of their automations.

A connected device's tools serve only its owner's own turns. With the owner's
explicit consent for one automation, that automation's deferred runs can use
the device while it is connected; nothing else can, and every discovery and
call rechecks the consent, the grant and the definition.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import aiosqlite

from openagent_core.capabilities import CapabilityCatalog
from openagent_core.contracts import ExecutionContext, PrincipalRef, ResourceRef
from openagent_core.core.execution_origin import TurnExecutionOrigin
from openagent_server.automation_authority import definition_digest
from openagent_server.automation_device_consent import AutomationDeviceConsents
from openagent_server.runtime_service import NativeRuntimeService


class _Policy:
    def __init__(self, service):
        self.service = service

    async def authorize(self, context, action, resource, *, audience=()):
        if action in {"tool.discover", "tool.call", "tool.publish"}:
            return await self.service._authorize_source(context, action, resource, audience=audience)
        return True


class _Registry:
    def __init__(self):
        self.calls = []
        self.online = True

    def list_servers(self, origin):
        if not self.online:
            raise PermissionError("offline")
        return [{"name": "client:shell"}]

    def list_tools(self, origin, name):
        self.list_servers(origin)
        return [{"name": "shell_exec", "description": "run a command"}]

    def describe_tool(self, origin, name, tool):
        self.list_servers(origin)
        return {"name": "shell_exec", "description": "run a command", "input_schema": {"type": "object"}}

    async def call_tool(self, origin, server, tool, arguments, *, session_id, execution_context, source_id):
        self.list_servers(origin)
        self.calls.append((origin.device_id, session_id, arguments))
        return {"content": [{"type": "text", "text": "ok"}], "structuredContent": {"device": origin.device_id}}


class _Connection:
    def __init__(self, registry, device_id="mac", owner="alice"):
        self.registry, self.device_id, self.owner_handle = registry, device_id, owner
        self.network_id, self.owner_kind, self.device_label = "tenant", "user", "Studio Mac"

    def origin(self, registry):
        return TurnExecutionOrigin(self.device_id, "desktop", 1, self.device_label, self.registry)


class _Automations:
    def __init__(self, db_path, definition):
        self.db_path, self.current = db_path, definition

    async def _grant(self, identifier):
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            row = await (await conn.execute(
                "SELECT * FROM standalone_automation_grants WHERE id=? AND revoked=0", (identifier,))).fetchone()
            return dict(row) if row else None

    async def definition(self, kind, definition_id):
        return dict(self.current)

    async def principal_active(self, principal):
        return True


class AutomationDeviceLoans(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db_path = str(Path(self.temp.name) / "agent.db")
        self.owner = PrincipalRef("openagent", "tenant", "alice")
        self.definition = {"id": "loop-1", "name": "Daily Triage", "prompt": "work", "cron_expression": "0 9 * * *",
                           "enabled": True}
        async with aiosqlite.connect(db_path) as conn:
            await conn.execute("CREATE TABLE standalone_automation_grants (id TEXT, kind TEXT, definition_id TEXT, "
                               "digest TEXT, principal_json TEXT, audience_json TEXT, scopes_json TEXT, revoked INTEGER)")
            await conn.execute("INSERT INTO standalone_automation_grants VALUES (?,?,?,?,?,?,?,0)", (
                "grant-1", "task", "loop-1", definition_digest("task", self.definition),
                json.dumps({"authority": "openagent", "tenant_id": "tenant", "subject_id": "alice", "kind": "user"}),
                json.dumps([{"authority": "openagent", "tenant_id": "tenant", "subject_id": "alice", "kind": "user"}]),
                "[]"))
            await conn.commit()
        service = NativeRuntimeService.__new__(NativeRuntimeService)
        service.agent = SimpleNamespace(name="agent", memory_db=SimpleNamespace(db_path=db_path), config={})
        service.automations = _Automations(db_path, self.definition)
        service.device_consents = AutomationDeviceConsents(db_path)
        service.dashboards = None
        service.official_connectors = SimpleNamespace(authorize_source=self._no_opinion)
        service._interactive_sources, service._interactive_leases, service._interactive_origins = {}, {}, {}
        service._lent_devices, service._lent_sources = {}, {}
        self.registry = _Registry()
        service.gateway = SimpleNamespace(capabilities=self.registry)
        service.runtime = SimpleNamespace(capabilities=CapabilityCatalog(_Policy(service)))
        self.service = service
        agent = PrincipalRef("openagent", "tenant", "agent", "agent")
        self.loop_run = ExecutionContext(agent, self.owner, self.owner, "loop-session", "agent", (self.owner,),
                                         delegation_id="grant-1", deferred=True)

    async def asyncTearDown(self):
        self.temp.cleanup()

    @staticmethod
    async def _no_opinion(context, resource):
        return None

    async def _consent(self):
        await self.service.device_consents.grant(tenant_id="tenant", owner="alice", device_id="mac",
                                                 kind="task", definition_id="loop-1")

    async def test_without_consent_the_automation_has_no_device(self):
        await self.service.lend_consented_devices(_Connection(self.registry))
        self.assertEqual((), await self.service.runtime.capabilities.discover(self.loop_run))

    async def test_a_consented_loop_sees_and_calls_the_device(self):
        await self._consent()
        await self.service.lend_consented_devices(_Connection(self.registry))
        tools = await self.service.runtime.capabilities.discover(self.loop_run)
        self.assertEqual(["Studio Mac"], [tool.target_label for tool in tools])
        result = await self.service.runtime.capabilities.call_tool(tools[0].tool_ref, {"command": "ls"}, self.loop_run)
        self.assertEqual("mac", result["structuredContent"]["device"])

    async def test_another_automation_or_a_changed_definition_is_refused(self):
        await self._consent()
        await self.service.lend_consented_devices(_Connection(self.registry))
        tools = await self.service.runtime.capabilities.discover(self.loop_run)
        source = tools[0].source_id
        other_grant = ExecutionContext(self.loop_run.author, self.owner, self.owner, "other", "agent",
                                       (self.owner,), delegation_id="grant-2", deferred=True)
        resource = ResourceRef("tool", "tenant", source + "/shell_exec")
        self.assertFalse(await self.service._authorize_source(other_grant, "tool.call", resource))
        self.service.automations.current = {**self.definition, "prompt": "changed"}
        self.assertFalse(await self.service._authorize_source(self.loop_run, "tool.call", resource))
        self.assertEqual([], self.registry.calls)

    async def test_withdrawing_the_consent_ends_the_loan_at_once(self):
        await self._consent()
        await self.service.lend_consented_devices(_Connection(self.registry))
        await self.service.device_consents.revoke(tenant_id="tenant", owner="alice", device_id="mac",
                                                  kind="task", definition_id="loop-1")
        self.service.revoke_automation_device("task", "loop-1", "mac")
        self.assertEqual((), await self.service.runtime.capabilities.discover(self.loop_run))
        self.assertEqual({}, self.service._lent_sources)

    async def test_another_person_s_device_is_never_lent(self):
        await self.service.device_consents.grant(tenant_id="tenant", owner="bob", device_id="bob-mac",
                                                 kind="task", definition_id="loop-1")
        await self.service.lend_consented_devices(_Connection(self.registry, device_id="bob-mac", owner="bob"))
        self.assertEqual({}, self.service._lent_devices)

    async def test_a_disconnect_ends_the_loan(self):
        await self._consent()
        await self.service.lend_consented_devices(_Connection(self.registry))
        self.service._detached_origins = {}
        self.service._revoke_origin_key(("mac", "desktop", 1, 0))
        self.assertEqual({}, self.service._lent_devices)


if __name__ == "__main__":
    unittest.main()
