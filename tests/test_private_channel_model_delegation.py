"""A mapped private Telegram turn delegates through the standalone model policy."""

import asyncio
from contextlib import AsyncExitStack
from dataclasses import replace
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from openagent_channel_bridges.contracts import BridgeContext, BridgeMessage, BridgePart
from openagent_channel_bridges.telegram import TelegramBridge
from openagent_core.contracts import CapabilityLease
from openagent_core.engine import Agent, MemoryDB
from openagent_core.mcp.pool import MCPPool
from openagent_core.models import discovery
from openagent_core.models.dispatcher import ModelDispatcher
from openagent_core.models.native_provider import NativeProvider
from openagent_core.models.providers.base import Model
from openagent_core.models.providers.response import ModelResponse
from openagent_core.runtime import current_execution_context
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_server.bridges.native_transport import NativeChannelTransport
from openagent_server.runtime_service import NativeRuntimeService


@pytest.mark.asyncio
async def test_private_channel_delegates_to_two_pinned_models_without_exposing_children(tmp_path, monkeypatch):
    child_calls = []
    delegated = False

    class FixtureModel(Model):
        def invoke(self, *args, **kwargs):
            raise AssertionError("Unexpected synchronous provider call")

        invoke_stream = invoke

        async def ainvoke(self, *, messages, **kwargs):
            nonlocal delegated
            context = current_execution_context()
            if context.parent_run_id:
                child_calls.append((self.id, context))
                return ModelResponse(role="assistant", content=f"Checked by {self.id}")
            if delegated:
                return ModelResponse(role="assistant", content="Both checks returned")
            delegated = True
            system_prompt = next(message.content for message in messages if message.role == "system")
            member_ids = ("fixture-reader", "fixture-writer")
            assert all(f'<member id="{member}"' in system_prompt for member in member_ids)
            return ModelResponse(role="assistant", tool_calls=[
                {"id": f"call-{member}", "type": "function", "function": {
                    "name": "delegate_task_to_member",
                    "arguments": json.dumps({"member_id": member, "task": f"Run the check for {member}"}),
                }} for member in member_ids
            ])

        async def ainvoke_stream(self, **kwargs):
            yield await self.ainvoke(**kwargs)

        def _parse_provider_response(self, response, **kwargs):
            return response

        _parse_provider_response_delta = _parse_provider_response

    def build_model(provider):
        return FixtureModel(id=provider.model.split(":", 1)[1], provider="fixture")

    monkeypatch.setattr(NativeProvider, "build_runtime_model", build_model)
    monkeypatch.setattr(NativeProvider, "_build_runtime_model", build_model)
    monkeypatch.setattr(discovery, "_fetch_openrouter_catalog", AsyncMock(return_value=[]))
    async with AsyncExitStack() as stack:
        db = MemoryDB(str(tmp_path / "state.sqlite"))
        await db.connect()
        stack.push_async_callback(db.close)
        directory = CoordinatorStore(db)
        await directory.set_network_role(role="coordinator", network_id="network", name="Fixture")
        mappings = {"101": "member", "202": "peer"}
        for handle in mappings.values():
            await directory.create_user(handle=handle, pake_record=b"fixture", pake_algo="fixture")
        provider = await db.upsert_provider(name="fixture", framework="api-based", enabled=True)
        for name in ("coordinator", "reader", "writer"):
            await db.upsert_model(provider_id=provider, model=name, enabled=True, is_classifier=name == "coordinator")
        agent = Agent(name="agent", model=ModelDispatcher(await db.materialise_providers_config(enabled_only=True)),
                      memory=db, mcp_pool=MCPPool.from_config([], include_defaults=False),
                      config={"_local_e2e": True, "channels": {"telegram": {"identity": {
                          "tenant_id": "network", "account_id": "7", "user_bindings": mappings,
                      }}}})
        agent.product_environment = {}
        stack.push_async_callback(agent.shutdown)
        leases = tuple(CapabilityLease(f"fixture-{i}", "test-process", "1:0") for i in range(5))

        async def capability_context(_context):
            return leases

        gateway = SimpleNamespace(agent=agent, runtime_capability_context_resolver=capability_context)
        service = NativeRuntimeService(gateway, agent)
        stack.push_async_callback(service.close)
        await service.start()
        host = NativeChannelTransport(service, "telegram", "binding")
        stack.push_async_callback(host.stop)
        bridge = TelegramBridge("", allowed_users=list(mappings), transport=host, binding_id="binding")

        async def get_chat(chat_id):
            return SimpleNamespace(id=chat_id, type="private")

        bridge._context_bot = SimpleNamespace(id=7, get_chat=get_chat)
        event = BridgeContext("binding", "telegram", "7", "101", "101", "event-1", conversation_kind="direct")
        direct = await bridge.attest_context(event)
        conversation = await host._execution(direct)
        await db.pin_session_model(conversation.session_id, "fixture:coordinator")
        async with asyncio.timeout(15):
            reply = await host.send(BridgeMessage(direct, (BridgePart(text="Delegate both checks"),)))
        assert reply.status == "completed"
        children = await service.runtime.children(reply.run_ref, conversation)
        assert [run.status for run in children] == ["success", "success"]
        sessions = {run.session_id for run in children}
        assert len(sessions) == 2 and conversation.session_id not in sessions
        assert {name for name, _ in child_calls} == {"reader", "writer"}
        for run in children:
            accepted = await service.runtime.accepted_request(run.run_id, conversation)
            pinned = accepted.request.model_ref.removeprefix("fixture:")
            names = {name for name, context in child_calls if context.session_id == run.session_id}
            assert names == {pinned}
            assert run.output == f"Checked by {pinned}"
        for _, context in child_calls:
            assert context.parent_run_id == reply.run_ref and context.initiator == conversation.initiator
            assert context.audience == conversation.audience and context.capabilities == leases

        peer = await bridge.attest_context(replace(event, actor_id="202", conversation_id="202", event_id="event-2"))
        peer_context = await host._execution(peer)
        with pytest.raises((PermissionError, LookupError)):
            await service.runtime.children(reply.run_ref, peer_context)
        for run in children:
            with pytest.raises((PermissionError, LookupError)):
                await service.runtime.get_run(run.run_id, peer_context)
