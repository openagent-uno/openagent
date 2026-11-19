"""The real stateless HTTP gateway must keep working after native adoption."""
import json
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import httpx
import pytest

from openagent_core.engine import MemoryDB
from openagent_core.subscriptions import service as subscriptions
from openagent_identity.auth.middleware import make_auth_middleware
from openagent_server.gateway.api.llm import handle_chat_completions


@pytest.fixture
async def gateway(tmp_path, monkeypatch):
    db = MemoryDB(str(tmp_path / "agent.db"))
    await db.connect()
    clients = []
    accounts = []
    for name in ("subscription-a", "subscription-b"):
        pid = await db.upsert_provider(
            name=name, framework="api-based",
            metadata={
                "access": "subscription", "vendor": "anthropic", "account_id": name,
                "account_fallback_group": "fixture", "account_fallback_priority": len(accounts),
            },
        )
        await db.upsert_model(provider_id=pid, model="claude-fixture")
        accounts.append(await db.get_provider(pid))
    factory = subscriptions.subscription_for
    calls = []
    answers = {}

    def service(row, path):
        result = factory(row, path)
        account = row["metadata"]["account_id"]

        def send(request):
            assert request.url.path == "/v1/chat/completions"
            calls.append((account, json.loads(request.content)))
            return answers[account]()

        client = httpx.AsyncClient(transport=httpx.MockTransport(send), base_url="http://native")
        clients.append((client, result))
        result.inference_client = lambda account_id: client
        return result

    monkeypatch.setattr(subscriptions, "subscription_for", service)
    monkeypatch.setenv("OPENAGENT_LLM_TOKEN", "fixture-llm")
    app = web.Application(middlewares=[make_auth_middleware(SimpleNamespace(network_id="fixture"))])
    app["gateway"] = SimpleNamespace(agent=SimpleNamespace(memory_db=db))
    app.router.add_post("/api/llm/chat/completions", handle_chat_completions)

    async def settings(request):
        return web.json_response({"private": True})

    app.router.add_get("/api/settings", settings)
    try:
        async with TestClient(TestServer(app, host="127.0.0.1")) as client:
            yield client, calls, answers
    finally:
        for client, result in clients:
            await client.aclose()
            await result.close()
        await db.close()


HEADERS = {"Authorization": "Bearer fixture-llm"}
BODY = {
    "model": "subscription-a:claude-fixture",
    "messages": [{"role": "user", "content": "fixture"}],
    "max_tokens": 23,
}


async def test_native_json_uses_core_fallback_and_scope(gateway):
    client, calls, answers = gateway
    answers["subscription-a"] = lambda: httpx.Response(
        429, json={"error": {"type": "rate_limit_error", "message": "fixture secret"}}
    )
    completion = {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
    answers["subscription-b"] = lambda: httpx.Response(200, json=completion)

    response = await client.post("/api/llm/chat/completions", json=BODY, headers=HEADERS)
    assert response.status == 200
    assert await response.json() == completion
    assert calls == [
        (account, {**BODY, "model": "claude-fixture", "stream": False})
        for account in ("subscription-a", "subscription-b")
    ]
    assert (await client.get("/api/settings", headers=HEADERS)).status == 401


async def test_native_stream_never_retries_after_output(gateway):
    client, calls, answers = gateway
    answers["subscription-a"] = lambda: httpx.Response(
        200, text='data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
                  'data: {"error":{"type":"subscription_rate_limited","code":"subscription_rate_limited","message":"fixture secret"}}\n\n'
    )
    response = await client.post("/api/llm/chat/completions", json={**BODY, "stream": True}, headers=HEADERS)
    assert response.status == 200
    body = await response.text()
    assert "hello" in body and "subscription_rate_limited" in body
    assert "[DONE]" not in body and "fixture secret" not in body
    assert [account for account, _ in calls] == ["subscription-a"]


async def test_native_stream_prefetches_before_committing_status(gateway):
    client, calls, answers = gateway
    answers["subscription-a"] = lambda: httpx.Response(
        401, json={"error": {"type": "authentication_error", "message": "fixture secret"}}
    )
    answers["subscription-b"] = lambda: httpx.Response(
        200, text='data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
    )
    response = await client.post("/api/llm/chat/completions", json={**BODY, "stream": True}, headers=HEADERS)
    assert response.status == 200
    assert "data: [DONE]" in await response.text()
    assert [account for account, _ in calls] == ["subscription-a", "subscription-b"]
