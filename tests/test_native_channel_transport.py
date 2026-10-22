"""Standalone real public Runtime/SQLite/CAS; provider/model are fixtures."""
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
import time
import sys

import pytest

from openagent_core import (CapabilityCatalog, FunctionSource, Runtime, RuntimeServices,
                            RuntimeSettings, ToolDefinition)
from openagent_core.artifacts import ArtifactRepository
from openagent_core.contracts import IdempotencyConflict, PrincipalRef, ResourceRef, RunRequest
from openagent_core.memory.db import MemoryDB
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import BridgeAttachment, BridgeContext, BridgeMessage, BridgePart
from openagent_server.bridges.native_transport import NativeChannelTransport, _Artifacts
from openagent_server.runtime_access import NativeRuntimeAuthorizer


class Provider(BaseBridge):
    name = "slack"
    async def _run(self):
        pass

    async def _delivery_context(self, context):
        return replace(context, audience_ids=tuple(self.members), audience_complete=True,
                       audience_verified_at=time.time())


async def assemble(tmp_path, *, settings=None):
    db = MemoryDB(str(tmp_path / "state.sqlite"))
    await db.connect()
    config = settings or {"channels": {"slack": {"identity": {"tenant_id": "network", "account_id": "team",
        "user_bindings": {"Ualice": "alice", "Ubob": "bob", "Ucarol": "carol"}}}}}
    users = {"alice", "bob", "carol"}
    async def snapshot(tenant):
        if tenant != "network":
            raise PermissionError("Unknown network")
        return {"users": tuple(users)}
    service = SimpleNamespace(agent=SimpleNamespace(name="agent", config=config, memory_db=db),
                              directory=SimpleNamespace(snapshot=snapshot))
    async def sources(context, action, resource, *, audience=()):
        return action in {"tool.discover", "tool.call", "tool.publish"} and resource.tenant_id == "network"
    service.authorizer = NativeRuntimeAuthorizer(SimpleNamespace(agent=service.agent), db.db_path,
                                                  source_authorizer=sources)
    catalog = CapabilityCatalog(service.authorizer)
    calls = []
    async def tool(arguments, context):
        calls.append((context.author.subject_id, context.session_id, arguments))
        return {"structuredContent": {"text": "same agent and catalog"}}
    source = FunctionSource((ToolDefinition("host-tool", "Normal host tool", {}),), {"host-tool": tool})
    catalog.register("same-host", source, source, target_label="Agent tools")
    class Executor:
        async def execute(self, request, context, runtime):
            tools = await catalog.discover(context)
            await catalog.call_tool(tools[0].tool_ref, {"input": request.input}, context)
            if request.input == "spawn child":
                child = await runtime.spawn(RunRequest("child-" + request.run_id,
                    "child-session-" + sha256(request.run_id.encode()).hexdigest(), "child-key", "child input"), context)
                return child.output
            refs = []
            if request.attachments:
                refs = [await ArtifactRepository(db, _Artifacts(host, current[0])).upload(
                    replace(context, ingress_id=None), b"name,value\nBoreal,200\n", filename="report.csv",
                    mime_type="text/csv", session_id=context.session_id)]
            await runtime.services.store.append_event(request.run_id, "run.stream",
                {"kind": "done", "text": "same agent and catalog", "attachments": refs})
            return "same agent and catalog"
    store = SqliteRuntimeStore(db.db_path)
    service.runtime = Runtime(RuntimeSettings("agent", tmp_path),
        RuntimeServices(store, Executor(), service.authorizer, catalog))
    await service.runtime.start()
    host = NativeChannelTransport(service, "slack", "slack")
    bridge = Provider(transport=host, binding_id="slack")
    bridge.members = ["Ualice", "Ubob"]
    context = BridgeContext("slack", "slack", "team", "Ualice", "channel", "event1",
        conversation_kind="channel", audience_ids=tuple(bridge.members), audience_complete=True,
        audience_verified_at=time.time())
    current = [context]
    return service, host, bridge, context, current, calls, users, store, db


@pytest.mark.asyncio
async def test_native_host_shared_actor_authority_runtime_cas_restart_and_epochs(tmp_path):
    service, host, bridge, context, current, calls, users, store, db = await assemble(tmp_path)
    try:
        # Generic binary and image are persisted by the public session-scoped CAS.
        file = tmp_path / "data.bin"
        file.write_bytes(b"synthetic binary")
        image = tmp_path / "image.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
        parts = (BridgePart(text="Alice first"), *[BridgePart(attachment=BridgeAttachment(
            kind, path.name, mime, path.stat().st_size, local_path=str(path),
            provider_attachment_id=path.name, sha256=sha256(path.read_bytes()).hexdigest()))
            for path, kind, mime in ((file, "file", "application/octet-stream"), (image, "image", "image/png"))])
        reply = await host.send(BridgeMessage(context, parts))
        assert reply.status == "completed" and len(reply.parts) == 2
        assert reply.parts[1].attachment.filename == "report.csv"
        assert Path(reply.parts[1].attachment.local_path).read_bytes() == b"name,value\nBoreal,200\n"
        accepted = await store.accepted_request(reply.run_ref)
        assert len(accepted.request.attachments) == 2
        assert accepted.author.subject_id == accepted.authority.subject_id == "alice"
        bob = replace(context, actor_id="Ubob", event_id="event2", audience_ids=("Ubob", "Ualice"))
        current[0] = bob
        second = await host.send(BridgeMessage(bob, (BridgePart(text="Bob same session"),)))
        assert reply.session_ref == second.session_ref
        accepted = await store.accepted_request(second.run_ref)
        assert accepted.author.subject_id == accepted.authority.subject_id == "bob"
        assert [call[0] for call in calls] == ["alice", "bob"]
        assert len({call[1] for call in calls}) == 1
        other = replace(bob, event_id="event3", conversation_id="channel2")
        current[0] = other
        third = await host.send(BridgeMessage(other, (BridgePart(text="different channel"),)))
        assert third.session_ref != reply.session_ref
        thread = replace(bob, event_id="event4", conversation_kind="thread", thread_id="thread1")
        current[0] = thread
        fourth = await host.send(BridgeMessage(thread, (BridgePart(text="different thread"),)))
        assert fourth.session_ref not in {reply.session_ref, third.session_ref}
        # Both the normal runtime/store and host are reconstructed. No channel
        # process-local session or event journal is needed for continuation.
        old_services = service.runtime.services
        await service.runtime.close()
        service.runtime = Runtime(RuntimeSettings("agent", tmp_path), RuntimeServices(
            SqliteRuntimeStore(db.db_path), old_services.executor, service.authorizer, old_services.capabilities))
        await service.runtime.start()
        # Exact event replay through a newly constructed host retains the durable run.
        replacement = NativeChannelTransport(service, "slack", "slack")
        replacement.bind_bridge(bridge)
        current[0] = bob
        replay = await replacement.send(BridgeMessage(bob, (BridgePart(text="Bob same session"),)))
        assert replay.run_ref == second.run_ref and len(calls) == 4
        with pytest.raises(IdempotencyConflict):
            await replacement.send(BridgeMessage(bob, (BridgePart(text="changed same provider event"),)))
        bridge.members.append("Ucarol")
        added = replace(bob, event_id="event5", audience_ids=tuple(bridge.members))
        current[0] = added
        fifth = await replacement.send(BridgeMessage(added, (BridgePart(text="new cohort"),)))
        assert fifth.session_ref not in {reply.session_ref, third.session_ref, fourth.session_ref}
        mapping = service.agent.config["channels"]["slack"]["identity"]["user_bindings"]
        mapping["Ubob"] = "bob-new"
        users.add("bob-new")
        rebound = replace(added, event_id="event-rebound")
        current[0] = rebound
        sixth = await replacement.send(BridgeMessage(rebound, (BridgePart(text="rebound mapping"),)))
        assert sixth.session_ref != fifth.session_ref and calls[-1][0] == "bob-new"
        users.remove("alice")
        with pytest.raises(PermissionError):
            await replacement.send(BridgeMessage(replace(added, event_id="event6"), (BridgePart(text="revoked recipient"),)))
        assert len(calls) == 6
        await replacement.stop()
    finally:
        await host.stop()
        await service.runtime.close()
        await db.close()


@pytest.mark.asyncio
async def test_native_voice_uses_public_configured_service_and_fresh_recipient_policy(tmp_path):
    from openagent_core.audio import VoiceService
    service, host, bridge, context, current, calls, users, store, db = await assemble(tmp_path)
    try:
        service.agent.config["voice"] = {"local_fallback": False}
        assert host._voice().fallback is None  # No implicit local model/download.
        worker = tmp_path / "voice-worker.py"
        worker.write_text("""import json,sys\nfrom pathlib import Path\np=json.load(sys.stdin)\nassert p['operation']=='transcribe'\nassert Path(p['path']).read_bytes()==b'synthetic audio'\nassert Path(p['path']).suffix in {'.webm','.m4a','.ogg','.opus'}\nprint(json.dumps({'text':'transcribed synthetic fixture'}))\n""")
        voice = VoiceService(db, worker_command=(sys.executable, "-I", "-B", str(worker)))
        host._voice = lambda: voice
        for filename, mime in (("slack.webm", "audio/webm"), ("slack.m4a", "audio/mp4"),
                               ("discord.ogg", "audio/ogg"), ("discord.opus", "audio/opus")):
            file = tmp_path / filename
            file.write_bytes(b"synthetic audio")
            attachment = BridgeAttachment("audio", filename, mime, file.stat().st_size,
                local_path=str(file), provider_attachment_id=filename, sha256=sha256(file.read_bytes()).hexdigest())
            if filename == "slack.webm":
                assert await host.transcribe(context, attachment) is None
                provider = await db.upsert_provider(name="fixture", framework="api-based", kind="stt",
                    api_key="synthetic-not-a-credential", base_url="https://fixture.invalid/v1")
                await db.upsert_model(provider_id=provider, model="fixture-stt", kind="stt")
            assert await host.transcribe(context, attachment) == "transcribed synthetic fixture"
        normal = voice.transcribe
        async def revoke_after_transcription(path):
            result = await normal(path)
            users.remove("bob")
            return result
        voice.transcribe = revoke_after_transcription
        with pytest.raises(PermissionError):
            await host.transcribe(context, attachment)
        assert calls == []  # Speech does not start a hidden agent/model run.
    finally:
        await host.stop()
        await service.runtime.close()
        await db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('choice', [None, False, True])
async def test_mapped_channels_reuse_the_exact_normal_speech_factory_defaults(tmp_path, monkeypatch, choice):
    from openagent_server import audio_service
    service, host, bridge, context, current, calls, users, store, db = await assemble(tmp_path)
    fallback = object()
    monkeypatch.setattr(audio_service, 'LocalAudioFallback', lambda runtime: fallback)
    if choice is not None:
        service.agent.config['voice'] = {'local_fallback':choice}
    try:
        gateway = SimpleNamespace(runtime_service=service)
        ordinary = audio_service.service_for_gateway(gateway)
        mapped = host._voice()
        assert ordinary.fallback is mapped.fallback is (None if choice is False else fallback)
        assert ordinary.timeout_seconds == mapped.timeout_seconds == 120
    finally:
        await host.stop()
        await service.runtime.close()
        await db.close()


@pytest.mark.asyncio
async def test_normal_child_tool_retains_individual_authority_and_cannot_borrow_other_lineage(tmp_path):
    service, host, bridge, context, current, calls, users, store, db = await assemble(tmp_path)
    try:
        reply = await host.send(BridgeMessage(context, (BridgePart(text="spawn child"),)))
        assert reply.status == "completed"
        parent = await host._execution(context)
        children = await service.runtime.children(reply.run_ref, parent)
        assert len(children) == 1 and children[0].status == "success"
        child = await store.accepted_request(children[0].run_id)
        assert child.author.kind == "agent" and child.authority == child.initiator == parent.initiator
        assert child.audience == parent.audience and child.parent_run_id == reply.run_ref
        assert len(calls) == 2  # Parent and child both use the exact normal catalog.
        forged = parent.child(session_id="unrelated", run_id="unknown-parent",
                              agent=PrincipalRef("openagent", "network", "agent", "agent"))
        assert not await service.authorizer.authorize(forged, "run.submit",
            ResourceRef("session", "network", "unrelated"), audience=forged.audience)
        users.remove("bob")
        with pytest.raises(PermissionError):
            await service.runtime.children(reply.run_ref, parent)
    finally:
        await host.stop()
        await service.runtime.close()
        await db.close()


@pytest.mark.asyncio
async def test_native_channel_host_never_maps_unknown_recipient_or_owner_fallback(tmp_path):
    service, host, bridge, context, current, calls, users, store, db = await assemble(tmp_path)
    try:
        bridge.members.append("unmapped")
        invalid = replace(context, audience_ids=tuple(bridge.members))
        assert not await host.authorize_delivery(invalid)
        with pytest.raises(PermissionError):
            await host.send(BridgeMessage(invalid, (BridgePart(text="no owner fallback"),)))
        bridge.members.pop()
        bound = await host._execution(context)
        resource = ResourceRef("session", "network", bound.session_id)
        assert await service.authorizer.authorize(bound, "run.submit", resource, audience=bound.audience)
        assert not await service.authorizer.authorize(replace(bound, session_id="borrowed"), "run.submit",
            ResourceRef("session", "network", "borrowed"), audience=bound.audience)
        async def revoke_during_source(context, action, resource, *, audience=()):
            users.remove("bob")
            return True
        service.authorizer.source_authorizer = revoke_during_source
        assert not await service.authorizer.authorize(bound, "tool.call",
            ResourceRef("tool", "network", "host/tool"), audience=bound.audience)
        users.add("bob")
        bridge.members.pop()  # Revocation invalidates an already-bound execution.
        assert not await service.authorizer.authorize(bound, "run.submit", resource, audience=bound.audience)
        assert calls == []
    finally:
        await host.stop()
        await service.runtime.close()
        await db.close()
