import asyncio
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from openagent_core.contracts import IdempotencyConflict
from openagent_core.core.on_behalf_context import (
    install_on_behalf_identity,
    reset_on_behalf_identity,
)
from openagent_server.runtime_service import NativeRuntimeService
from test_runtime_access import Request


class FakeAgent:
    name = "test-agent"
    config = {}
    capability_pool = None

    def __init__(self, path):
        async def list_mcps():
            return []

        self.memory_db = SimpleNamespace(db_path=str(path), list_mcps=list_mcps)
        self.config = {"_local_e2e": True}
        self.calls = []
        self.running = asyncio.Event()
        self.release = asyncio.Event()

    async def initialize(self):
        pass

    def set_capability_pool(self, pool):
        self.capability_pool = pool

    async def run_stream(self, message, **kwargs):
        self.calls.append((message, kwargs))
        await kwargs["on_status"]("Working")
        yield {"kind": "delta", "text": "answer: "}
        if message == "wait":
            self.running.set()
            await self.release.wait()
        yield {
            "kind": "done",
            "text": "answer: " + message,
            "attachments": [{"id": "artifact"}],
        }


class RuntimeServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.agent = FakeAgent(Path(self.directory.name) / "state.sqlite3")
        from openagent_storage_sqlite import SqliteRuntimeStore

        seed = SqliteRuntimeStore(self.agent.memory_db.db_path)
        await seed.start()
        await seed.close()

        async def authorized(request, certificate):
            return True

        self.gateway = SimpleNamespace(
            agent=self.agent, _request_device_still_authorized=authorized
        )
        self.service = NativeRuntimeService(self.gateway, self.agent)
        await self.service.start()
        self.identity = await self.service.authorizer.bind_request(
            Request(self.gateway, "alice")
        )
        self.token = install_on_behalf_identity(self.identity)

    async def asyncTearDown(self):
        reset_on_behalf_identity(self.token)
        await self.service.close()
        self.directory.cleanup()

    async def test_lost_response_replays_same_run_without_reexecuting(self):
        status = []

        async def progress(value):
            status.append(value)

        args = dict(
            session_id="session",
            run_id="same-request",
            attachments=[{"id": "input-artifact"}],
        )
        first = [
            e
            async for e in self.service.facade.run_stream(
                "hello", on_status=progress, **args
            )
        ]
        second = [e async for e in self.service.facade.run_stream("hello", **args)]
        self.assertEqual(first, second)
        self.assertEqual(len(self.agent.calls), 1)
        self.assertEqual(
            self.agent.calls[0][1]["attachments"], [{"id": "input-artifact"}]
        )
        self.assertEqual(first[-1]["attachments"], [{"id": "artifact"}])
        self.assertEqual(status, ["Working"])
        context = await self.service.authorizer.context_for_identity(
            self.identity, "session"
        )
        self.assertEqual(
            (await self.service.runtime.get_run("same-request", context)).status,
            "success",
        )
        with self.assertRaises(IdempotencyConflict):
            await self.service.facade.run("different input", **args)

    async def test_cancel_stops_exact_run_and_another_session_completes(self):
        waiting = asyncio.create_task(
            self.service.facade.run("wait", session_id="one", run_id="waiting")
        )
        await asyncio.wait_for(self.agent.running.wait(), 3)
        answer = await asyncio.wait_for(
            self.service.facade.run("hello", session_id="two", run_id="other"), 3
        )
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertEqual(answer, "answer: hello")
        context = await self.service.authorizer.context_for_identity(
            self.identity, "one"
        )
        self.assertEqual(
            (await self.service.runtime.get_run("waiting", context)).status, "cancelled"
        )
        other = await self.service.authorizer.context_for_identity(self.identity, "two")
        self.assertEqual(
            (await self.service.runtime.get_run("other", other)).status, "success"
        )

    async def test_no_certificate_context_cannot_start_an_agent(self):
        token = install_on_behalf_identity(None)
        try:
            with self.assertRaises(PermissionError):
                await self.service.facade.run(
                    "hello", session_id="session", run_id="blocked"
                )
        finally:
            reset_on_behalf_identity(token)
        self.assertEqual(self.agent.calls, [])

    async def test_admission_persists_before_observation_and_retry_keeps_target(self):
        first = await self.service.admit_message(
            identity=self.identity, message="wait", session_id="shared", run_id="old"
        )
        await asyncio.wait_for(self.agent.running.wait(), 3)
        second = await self.service.admit_message(
            identity=self.identity,
            message="hello",
            session_id="shared",
            run_id="new",
            steer_run_id="old",
        )
        retry = await self.service.admit_message(
            identity=self.identity,
            message="hello",
            session_id="shared",
            run_id="new",
            steer_run_id="unrelated",
        )
        self.assertEqual(second.request, retry.request)
        self.assertEqual(retry.request.steer_run_id, "old")
        self.assertEqual(
            (await self.service.runtime.wait("new", second.context)).status, "success"
        )
        self.assertEqual(
            (await self.service.runtime.get_run("old", first.context)).status,
            "cancelled",
        )
        self.assertEqual(
            [e async for e in self.service.observe_run(second)][-1]["text"],
            "answer: hello",
        )
        self.assertEqual(len(self.agent.calls), 2)

    async def test_detaching_observer_does_not_cancel_preadmitted_execution(self):
        prepared = await self.service.admit_message(
            identity=self.identity,
            message="wait",
            session_id="shared",
            run_id="detached",
        )
        prepared.cancel_on_detach = False
        await asyncio.wait_for(self.agent.running.wait(), 3)

        async def observe():
            return [e async for e in self.service.observe_run(prepared)]

        observer = asyncio.create_task(observe())
        await asyncio.sleep(0.05)
        observer.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await observer
        self.assertFalse(
            (await self.service.runtime.get_run("detached", prepared.context)).terminal
        )
        self.agent.release.set()
        self.assertEqual(
            (await self.service.runtime.wait("detached", prepared.context)).status,
            "success",
        )

    async def test_retry_without_observer_cache_uses_original_durable_request(self):
        original = await self.service.admit_message(
            identity=self.identity,
            message="hello",
            session_id="durable",
            run_id="durable-request",
        )
        await self.service.runtime.wait("durable-request", original.context)
        self.service.prepared_runs.clear()
        retry = await self.service.admit_message(
            identity=self.identity,
            message="hello",
            session_id="durable",
            run_id="durable-request",
            steer_run_id="never-accepted",
        )
        self.assertIsNone(retry.request.steer_run_id)
        self.assertEqual(
            [e async for e in self.service.observe_run(retry)][-1]["text"],
            "answer: hello",
        )
        self.assertEqual(len(self.agent.calls), 1)
        with self.assertRaises(IdempotencyConflict):
            await self.service.admit_message(
                identity=self.identity,
                message="changed",
                session_id="durable",
                run_id="durable-request",
            )
