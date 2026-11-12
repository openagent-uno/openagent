"""Canonical Runtime child lineage reaches shared observers before either run completes."""

import asyncio
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from openagent_core.contracts import ExecutionContext, PrincipalRef, RunRequest
from openagent_core.runtime import Runtime, RuntimeServices, RuntimeSettings, provider_tool_call_scope
from openagent_storage_sqlite import SqliteRuntimeStore

from openagent_server.gateway.collaboration import Collaboration
from openagent_server.gateway.collaboration_hub import Observer
from openagent_server.runtime_service import NativeRuntimeService, PreparedRun


@pytest.mark.asyncio
async def test_stream_channel_observes_child_operations_live_and_detach_does_not_cancel_execution(tmp_path):
    from openagent_core.stream.child_stream import install_child_stream_emitter, reset_child_stream_emitter
    actor = PrincipalRef('openagent', 'tenant', 'member')
    context = ExecutionContext(actor, actor, actor, 'parent', 'agent', (actor,))
    release = asyncio.Event()
    started = []
    store = SqliteRuntimeStore(tmp_path/'state.sqlite')

    class Policy:
        async def authorize(self, *_args, **_kwargs):
            return True

    class Executor:
        async def execute(self, request, ctx, runtime):
            started.append(request.run_id)
            if request.run_id == 'parent-run':
                await store.append_event(request.run_id, 'run.status', {'text': json.dumps({
                    'tool_name': 'delegate_task_to_member', 'tool_call_id': 'exact-call'})})
                with provider_tool_call_scope('exact-call'):
                    await runtime.spawn(RunRequest('child-run', 'child', 'child-key', 'Inspect'), ctx)
                await store.append_event(request.run_id, 'run.stream', {'kind': 'done', 'text': 'Parent complete'})
                return 'Parent complete'
            await store.append_event(request.run_id, 'run.status', {'text': 'First child operation'})
            await release.wait()
            return 'Child complete'

    runtime = Runtime(RuntimeSettings('agent', tmp_path), RuntimeServices(store, Executor(), Policy()))
    await runtime.start()
    class Service:
        observe_run = NativeRuntimeService.observe_run
    service = Service()
    service.runtime = runtime
    request = RunRequest('parent-run', 'parent', 'parent-key', 'Delegate')
    prepared = PreparedRun(request, context, cancel_on_detach=False)
    frames, parent_status = [], []
    async def emit(frame):
        frames.append(frame)
    async def status(text):
        parent_status.append(json.loads(text))
    async def observe():
        async for _ in service.observe_run(prepared, on_status=status):
            pass
    token = install_child_stream_emitter(emit)
    observer = None
    try:
        await runtime.submit(request, context)
        observer = asyncio.create_task(observe())
        async with asyncio.timeout(3):
            while not any(f.get('text') == 'First child operation' for f in frames):
                await asyncio.sleep(.01)
        assert any(s.get('child_run_id') == 'child-run' for s in parent_status)
        assert (await runtime.get_run('parent-run', context)).status == 'running'
        await store.append_event('child-run', 'run.status', {'text': 'Second child operation'})
        async with asyncio.timeout(3):
            while not any(f.get('text') == 'Second child operation' for f in frames):
                await asyncio.sleep(.01)
        observer.cancel()
        await asyncio.gather(observer, return_exceptions=True)
        assert (await runtime.get_run('child-run', context)).status == 'running'
        observer = asyncio.create_task(observe())
        release.set()
        await asyncio.wait_for(observer, 3)
        assert started == ['parent-run', 'child-run']
        assert any(f.get('kind') == 'turn_complete' and f.get('reason') == 'completed' for f in frames)
        assert all(f['session_id'] == 'child' for f in frames)
    finally:
        release.set()
        if observer is not None and not observer.done():
            observer.cancel()
            await asyncio.gather(observer, return_exceptions=True)
        reset_child_stream_emitter(token)
        await runtime.close()


@pytest.mark.asyncio
async def test_live_child_link_and_projection_check_child_acl(tmp_path: Path):
    actor = PrincipalRef("openagent", "tenant", "member", "user")
    context = ExecutionContext(actor, actor, actor, "parent", "agent", (actor,))
    store = SqliteRuntimeStore(tmp_path / "state.sqlite")
    release = asyncio.Event()

    class Policy:
        async def authorize(self, *_args, **_kwargs):
            return True

    class Executor:
        async def execute(self, request, ctx, runtime):
            if request.run_id == "parent-run":
                await store.append_event(request.run_id, "run.status", {
                    "text": json.dumps({"tool_name": "delegate_task_to_member", "tool_call_id": "exact-call"})})
                with provider_tool_call_scope("exact-call"):
                    await runtime.spawn(RunRequest("child-run", "child", "child-run", "Investigate"), ctx)
                return "Parent complete"
            await store.append_event(request.run_id, "run.stream", {"kind": "delta", "text": "Partial child"})
            await store.append_event(request.run_id, "run.status", {
                "text": json.dumps({"tool_name": "inspect", "tool_call_id": "child-tool"})})
            await release.wait()
            await store.append_event(request.run_id, "run.stream", {"kind": "done", "text": "Child complete"})
            return "Child complete"

    runtime = Runtime(RuntimeSettings("agent", tmp_path), RuntimeServices(store, Executor(), Policy()))
    await runtime.start()

    class ObservationService:
        observe_run = NativeRuntimeService.observe_run

        async def context(self, _actor, session_id):
            return replace(context, session_id=session_id)

    service = ObservationService()
    service.runtime = runtime
    collaboration = Collaboration(SimpleNamespace(runtime_service=service))
    request = RunRequest("parent-run", "parent", "parent-run", "Delegate")
    collaboration.hub.begin("parent", "Delegate", run_id=request.run_id)
    await runtime.submit(request, context)
    prepared = PreparedRun(request, context, cancel_on_detach=False,
        on_child=lambda parent, sid, run: collaboration._observe_child(actor, parent, sid, run))

    async def status(text):
        collaboration.hub.publish({"type": "status", "session_id": "parent", "text": text})

    async def observe_parent():
        async for _ in service.observe_run(prepared, on_status=status):
            pass

    observer = asyncio.create_task(observe_parent())
    try:
        async with asyncio.timeout(4):
            while True:
                parent = collaboration.hub.sessions["parent"]["turns"][-1]
                child_state = collaboration.hub.sessions.get("child")
                if (parent.get("tools") and parent["tools"][0]["toolInfo"].get("child_session_id") == "child"
                        and child_state and child_state["turns"][-1].get("tools")):
                    break
                await asyncio.sleep(.01)
        child = child_state["turns"][-1]
        assert child["active"]
        assert child["messages"][0]["text"] == "Investigate"
        assert child["messages"][1]["text"] == "Partial child"
        assert child["tools"][0]["id"] == "child-tool"
        assert (await runtime.get_run("parent-run", context)).status == "running"

        ws = SimpleNamespace(send_json=AsyncMock())
        viewer = Observer(ws, object(), {"userId": "observer", "name": "Observer"})
        viewer.sessions = {"parent"}
        allowed = {"parent"}

        async def authorize(_actor, targets):
            return {**viewer.user, "allowed": [item for item in targets if item["id"] in allowed]}

        with patch("openagent_server.gateway.collaboration_hub.authorize", authorize):
            async def sent_tool():
                await collaboration.hub.deliver(viewer)
                frame = next(call.args[0] for call in reversed(ws.send_json.await_args_list)
                             if call.args[0]["type"] == "shared_state")
                return frame["revision"], frame["turns"][-1]["tools"][0]["toolInfo"]

            private_revision, private = await sent_tool()
            assert "child_session_id" not in private
            allowed.add("child")
            public_revision, public = await sent_tool()
            assert public_revision > private_revision
            assert public["child_session_id"] == "child"
            allowed.remove("child")
            revoked_revision, revoked = await sent_tool()
            assert revoked_revision > public_revision
            assert "child_session_id" not in revoked
    finally:
        release.set()
        try:
            await asyncio.wait_for(observer, 3)
        finally:
            await collaboration.close()
            await runtime.close()
