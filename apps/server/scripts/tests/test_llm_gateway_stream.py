"""Generic LLM gateway — ``stream: true`` SSE relay over real sockets.

``test_llm_gateway`` pins the non-streaming contract against a patched
``httpx.AsyncClient``. Streaming is about timing and framing, which a patched
client cannot prove, so this suite runs the REAL handler inside a local
aiohttp app and points the provider row at a fake upstream (another local
aiohttp server) that emits server-sent events with delays between chunks.

What it pins:

  - ``stream: true`` relays the upstream bytes verbatim, in order, and
    INCREMENTALLY (the first event reaches the caller long before the
    upstream finishes), with ``text/event-stream`` / ``no-cache`` /
    ``X-Accel-Buffering: no``; the upstream sees ``stream: true`` and the
    bare model id.
  - the timeout bounds connect and each read, not the whole stream: a
    stream that lasts longer than the timeout but never pauses longer than
    it is delivered complete.
  - ``stream: false`` / absent still yields one JSON body and sends
    ``stream: false`` upstream.
  - an upstream 4xx/5xx before the first byte is the same JSON error shape
    as the non-streaming path (status preserved, truncated body carried).
  - a connect timeout and an upstream that never sends headers both map to
    ``upstream_timeout``.

Everything binds to 127.0.0.1 on ephemeral ports; no external network.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager, contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from ._framework import TestContext, test

# Event payloads the fake upstream emits, one SSE frame each.
_EVENTS = [
    {"choices": [{"delta": {"role": "assistant"}, "index": 0}]},
    {"choices": [{"delta": {"content": "Hel"}, "index": 0}]},
    {"choices": [{"delta": {"content": "lo"}, "index": 0}]},
    {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]},
]
_GAP_S = 0.4  # pause between upstream frames


def _frames() -> list[bytes]:
    out = [f"data: {json.dumps(e)}\n\n".encode() for e in _EVENTS]
    out.append(b"data: [DONE]\n\n")
    return out


class _FakeDB:
    def __init__(self, providers: list[dict]) -> None:
        self._providers = providers

    async def list_providers(self, **_kw) -> list[dict]:
        return list(self._providers)


@contextmanager
def _timeout_env(value: str | None):
    prev = os.environ.get("OPENAGENT_LLM_GATEWAY_TIMEOUT")
    if value is None:
        os.environ.pop("OPENAGENT_LLM_GATEWAY_TIMEOUT", None)
    else:
        os.environ["OPENAGENT_LLM_GATEWAY_TIMEOUT"] = value
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop("OPENAGENT_LLM_GATEWAY_TIMEOUT", None)
        else:
            os.environ["OPENAGENT_LLM_GATEWAY_TIMEOUT"] = prev


@asynccontextmanager
async def _upstream(mode: str):
    """Start a fake OpenAI-compatible provider; yields (base_url, seen_bodies).

    mode: ``sse`` streams ``_frames()`` with ``_GAP_S`` gaps (or one JSON
    body when the request has ``stream: false``), ``error`` answers 503
    before any stream byte, ``hang`` never sends response headers.
    """
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    seen: list[dict] = []

    async def handler(request: web.Request) -> web.StreamResponse:
        body = await request.json()
        seen.append(body)
        if mode == "error":
            return web.json_response({"error": {"message": "overloaded"}}, status=503)
        if mode == "hang":
            await asyncio.sleep(30)
        if body.get("stream") is not True:
            return web.json_response({
                "choices": [{"message": {"role": "assistant", "content": "Hello"}}],
                "usage": {"total_tokens": 3},
            })
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await resp.prepare(request)
        for i, frame in enumerate(_frames()):
            if i:
                await asyncio.sleep(_GAP_S)
            await resp.write(frame)
        await resp.write_eof()
        return resp

    app = web.Application()
    app.router.add_post("/v1/chat/completions", handler)
    server = TestServer(app, host="127.0.0.1")
    await server.start_server()
    try:
        yield f"http://127.0.0.1:{server.port}/v1", seen
    finally:
        await server.close()


@asynccontextmanager
async def _gateway(base_url: str):
    """Serve the real handler with a one-provider registry; yields a client."""
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    from openagent_server.gateway.api.llm import handle_chat_completions

    db = _FakeDB([{
        "name": "local", "framework": "api-based", "base_url": base_url,
        "api_key": "provider-secret-key", "enabled": True,
    }])
    app = web.Application()
    app["gateway"] = SimpleNamespace(agent=SimpleNamespace(memory_db=db))
    app.router.add_post("/api/llm/chat/completions", handle_chat_completions)
    client = TestClient(TestServer(app, host="127.0.0.1"))
    await client.start_server()
    try:
        yield client
    finally:
        await client.close()


def _body(**extra) -> dict:
    body = {"model": "local:m-1", "messages": [{"role": "user", "content": "hi"}]}
    body.update(extra)
    return body


# ── streaming relay ──────────────────────────────────────────────────


@test("llm_gateway", "stream=true relays SSE incrementally, in order, verbatim")
async def t_stream_relay(ctx: TestContext) -> None:
    with _timeout_env(None):
        async with _upstream("sse") as (base_url, seen), _gateway(base_url) as client:
            t0 = time.monotonic()
            resp = await client.post("/api/llm/chat/completions", json=_body(stream=True))
            assert resp.status == 200, await resp.text()
            assert resp.headers["Content-Type"].startswith("text/event-stream"), resp.headers
            assert resp.headers.get("Cache-Control") == "no-cache", resp.headers
            assert resp.headers.get("X-Accel-Buffering") == "no", resp.headers
            received = b""
            arrivals: list[tuple[float, int]] = []
            async for chunk in resp.content.iter_any():
                received += chunk
                arrivals.append((time.monotonic() - t0, len(received)))
    expected = b"".join(_frames())
    assert received == expected, received
    total_upstream = _GAP_S * (len(_frames()) - 1)
    first_at = arrivals[0][0]
    # The first frame must arrive well before the upstream is done — a
    # buffering relay would deliver everything at ~total_upstream.
    assert first_at < total_upstream / 2, (first_at, arrivals)
    assert len(arrivals) >= 3, f"expected incremental delivery, got {arrivals}"
    assert seen[0]["stream"] is True and seen[0]["model"] == "m-1", seen[0]


@test("llm_gateway", "stream=true: timeout bounds each read, not the whole stream")
async def t_stream_outlives_timeout(ctx: TestContext) -> None:
    # Whole stream ≈ 1.6s, every gap 0.4s, timeout 1.0s.
    with _timeout_env("1.0"):
        async with _upstream("sse") as (base_url, _), _gateway(base_url) as client:
            resp = await client.post("/api/llm/chat/completions", json=_body(stream=True))
            assert resp.status == 200, await resp.text()
            received = await resp.read()
    assert received == b"".join(_frames()), received
    assert received.endswith(b"data: [DONE]\n\n")


# ── non-streaming paths stay unchanged ───────────────────────────────


@test("llm_gateway", "stream=false / absent → one JSON body, stream=false upstream")
async def t_non_stream_unchanged(ctx: TestContext) -> None:
    with _timeout_env(None):
        async with _upstream("sse") as (base_url, seen), _gateway(base_url) as client:
            for extra in ({}, {"stream": False}, {"stream": "true"}):
                resp = await client.post("/api/llm/chat/completions", json=_body(**extra))
                assert resp.status == 200, await resp.text()
                assert resp.headers["Content-Type"].startswith("application/json"), resp.headers
                data = await resp.json()
                assert data["choices"][0]["message"]["content"] == "Hello", data
    assert [b["stream"] for b in seen] == [False, False, False], seen


# ── errors before the first byte ─────────────────────────────────────


@test("llm_gateway", "stream=true + upstream 5xx before first byte → JSON error shape")
async def t_stream_upstream_error(ctx: TestContext) -> None:
    with _timeout_env(None):
        async with _upstream("error") as (base_url, _), _gateway(base_url) as client:
            resp = await client.post("/api/llm/chat/completions", json=_body(stream=True))
            assert resp.status == 503, await resp.text()
            assert resp.headers["Content-Type"].startswith("application/json"), resp.headers
            err = (await resp.json())["error"]
    assert err["type"] == "upstream_error", err
    assert err["upstream_status"] == 503, err
    assert "overloaded" in err["upstream_body"], err


@test("llm_gateway", "stream=true + upstream never answers → upstream_timeout")
async def t_stream_header_timeout(ctx: TestContext) -> None:
    with _timeout_env("0.5"):
        async with _upstream("hang") as (base_url, _), _gateway(base_url) as client:
            resp = await client.post("/api/llm/chat/completions", json=_body(stream=True))
            assert resp.status == 502, await resp.text()
            err = (await resp.json())["error"]
    assert err["type"] == "upstream_timeout", err


@test("llm_gateway", "stream=true + connect timeout → upstream_timeout")
async def t_stream_connect_timeout(ctx: TestContext) -> None:
    import httpx

    from openagent_server.gateway.api import llm

    real_client = httpx.AsyncClient

    def _refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("connect timed out", request=request)

    def _factory(**kwargs):
        return real_client(transport=httpx.MockTransport(_refuse), **kwargs)

    with _timeout_env(None), patch.object(llm.httpx, "AsyncClient", _factory):
        async with _gateway("http://127.0.0.1:9/v1") as client:
            resp = await client.post("/api/llm/chat/completions", json=_body(stream=True))
            assert resp.status == 502, await resp.text()
            err = (await resp.json())["error"]
    assert err["type"] == "upstream_timeout", err
