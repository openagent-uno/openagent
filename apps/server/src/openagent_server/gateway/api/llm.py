"""POST /api/llm/chat/completions — a generic LLM gateway.

A single, stateless, product-neutral chat-completions endpoint. Any
service in the suite can make an LLM call THROUGH OpenAgent's
already-configured providers (the ``providers`` registry + its stored
API keys) without holding its own vendor credentials. This is a PURE
PASSTHROUGH GATEWAY: the caller owns the prompt / rubric / schema; the
gateway resolves ``<provider>`` against the registry and forwards the request
to the configured API or the in-process Core subscription service.

Nothing here is specific to any caller, product, prompt, provider, or
model — every one of those is data supplied at call time:

  - the provider name comes from the ``model`` field (``provider:model``),
  - the API endpoint or native subscription connection comes from that row,
  - the messages / response_format / sampling params come from the body.

Path shape: an OpenAI client configured with
``base_url=".../api/llm"`` doing the standard
``POST {base_url}/chat/completions`` lands here, so callers can use any
off-the-shelf OpenAI SDK. Auth is the gateway's shared secret via
``Authorization: Bearer`` (see ``network/auth/middleware.py``) — the
PROVIDER's own key is injected server-side and never leaves the process.

Contract:

  Request body (OpenAI chat-completions shape):
    { "model": "<provider>:<model_id>", "messages": [...],
      "response_format"?: {...}, "temperature"?, "max_tokens"?,
      "top_p"?, ... }

  - ``model`` MUST be ``"<provider_name>:<model_id>"`` (split on the
    FIRST ``:``). No default provider is assumed — a missing ``:`` is a
    400. The provider is matched by ``row["name"]`` against the
    ``providers`` registry; unknown → 404, disabled → 400.
  - The upstream call is ``POST {base_url}/chat/completions`` with the
    body forwarded verbatim except ``model`` (rewritten to the bare
    ``<model_id>``) and ``stream`` (true relays the provider's SSE
    stream as it arrives; anything else is forced false).
  - The upstream JSON is returned verbatim with the upstream status so
    ``choices`` / ``usage`` pass straight through. Any error (bad
    request, unknown provider, upstream non-2xx, timeout, connection
    failure) is a clean JSON error — the handler never raises.
"""

from __future__ import annotations

import asyncio
from contextlib import aclosing
import json
import logging
import os
import time
from typing import TYPE_CHECKING, Any

import httpx

from openagent_core.core.logging import elog
from openagent_server.gateway.api._common import gateway_db

if TYPE_CHECKING:
    from aiohttp import web

logger = logging.getLogger(__name__)

# Upstream call budget: the whole call when non-streaming, connect and
# each read when streaming. Overridable per-deployment so a slow
# self-hosted model doesn't get cut off — no URL/model/provider is
# hardcoded, and neither is this.
_DEFAULT_TIMEOUT_S = 30.0
# Truncate relayed upstream error bodies so a verbose provider error page
# can't bloat the response (or the logs, though we never log bodies).
_ERR_BODY_CAP = 2000


def _timeout_seconds(default: float = _DEFAULT_TIMEOUT_S) -> float:
    """Resolve the upstream timeout from the environment (default 30s)."""
    raw = os.environ.get("OPENAGENT_LLM_GATEWAY_TIMEOUT", "").strip()
    if not raw:
        return default
    try:
        val = float(raw)
        return val if val > 0 else default
    except (TypeError, ValueError):
        return default


def _error(message: str, status: int, *, err_type: str = "gateway_error",
           **extra: Any) -> "web.Response":
    """Build an OpenAI-shaped JSON error so standard clients parse it."""
    from aiohttp import web as _web

    payload: dict[str, Any] = {"message": message, "type": err_type}
    payload.update(extra)
    return _web.json_response({"error": payload}, status=status)


async def _relay_stream(request: "web.Request", url: str, outbound: dict,
                        headers: dict, provider_name: str,
                        model_field: str) -> "web.StreamResponse":
    """Relay a provider's SSE chat-completions stream byte for byte.

    Errors before the first byte are the same JSON errors as the
    non-streaming path. The timeout applies to connecting and to each read,
    so a long answer that keeps producing tokens is never cut off.
    """
    from aiohttp import web as _web

    timeout = _timeout_seconds()
    client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))
    t0 = time.monotonic()
    try:
        upstream = await client.send(
            client.build_request("POST", url, json=outbound, headers=headers),
            stream=True,
        )
    except httpx.TimeoutException:
        await client.aclose()
        elog("llm_gateway.timeout", level="warning",
             provider=provider_name, model=model_field, timeout_s=timeout)
        return _error(
            f"upstream provider '{provider_name}' timed out after {timeout}s",
            502, err_type="upstream_timeout",
        )
    except Exception as exc:  # noqa: BLE001 — connection/transport failure
        await client.aclose()
        elog("llm_gateway.connect_error", level="warning",
             provider=provider_name, model=model_field, error=str(exc))
        return _error(
            f"could not reach upstream provider '{provider_name}': {exc}",
            502, err_type="upstream_unreachable",
        )

    status = upstream.status_code
    if not 200 <= status < 300:
        body_text = (await upstream.aread()).decode("utf-8", "replace")[:_ERR_BODY_CAP]
        await upstream.aclose()
        await client.aclose()
        elog("llm_gateway.upstream_error", level="warning", provider=provider_name,
             model=model_field, upstream_status=status, stream=True)
        return _error(
            f"upstream provider '{provider_name}' returned HTTP {status}",
            status if status >= 400 else 502,
            err_type="upstream_error",
            upstream_status=status,
            upstream_body=body_text,
        )

    response = _web.StreamResponse(status=200, headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
    await response.prepare(request)
    try:
        async for chunk in upstream.aiter_raw():
            await response.write(chunk)
        elog("llm_gateway.ok", level="info", provider=provider_name, model=model_field,
             upstream_status=status, stream=True,
             latency_ms=round((time.monotonic() - t0) * 1000, 1))
    except Exception as exc:  # noqa: BLE001 — upstream or caller went away mid-stream
        elog("llm_gateway.stream_error", level="warning", provider=provider_name,
             model=model_field, error=str(exc))
    finally:
        await upstream.aclose()
        await client.aclose()
    await response.write_eof()
    return response


async def _subscription_rows(db, row, providers, model_id):
    from openagent_core.models.catalog import build_runtime_model_id
    from openagent_core.models.subscription_routes import account_routes_for

    metadata = row.get("metadata") or {}
    if metadata.get("account_fallback_group"):
        config = await db.materialise_providers_config()
        requested = build_runtime_model_id(row["name"], model_id, row.get("framework"))
        routes = account_routes_for(row, requested, config, db.db_path)
        if routes is not None:
            by_name = {provider["name"]: provider for provider in providers}
            return [
                by_name[entry.provider] for entry in routes.entries
                if entry.provider in by_name
                and not (by_name[entry.provider].get("metadata") or {}).get("subscription_remote")
            ]
    return [row]


async def _subscription_reply(request, db, row, providers, body):
    """Relay one raw Chat Completions request through the public Core service."""
    from aiohttp import web
    from openagent_core.core.runtime_errors import ModelProviderError
    from openagent_core.models.credential_pool import rotates_account
    from openagent_core.subscriptions.errors import SubscriptionError
    from openagent_core.subscriptions.service import subscription_for

    last = None
    try:
        for candidate in await _subscription_rows(db, row, providers, body["model"]):
            metadata = candidate.get("metadata") or {}
            service = subscription_for(candidate, db.db_path)
            account = metadata.get("account_id")
            if service is None or not account:
                raise ValueError("Invalid subscription connection")
            timeout = _timeout_seconds(service.settings.request_timeout)
            try:
                if not body["stream"]:
                    result = await asyncio.wait_for(service.complete(body, account_id=account), timeout)
                    return web.json_response(result)
                iterator = service.stream_chat(body, account_id=account)
                async with aclosing(iterator):
                    first = await asyncio.wait_for(anext(iterator), timeout)
                    response = web.StreamResponse(headers={
                        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                        "X-Accel-Buffering": "no",
                    })
                    await response.prepare(request)
                    try:
                        await response.write(first.encode())
                        while True:
                            frame = await asyncio.wait_for(anext(iterator), timeout)
                            await response.write(frame.encode())
                    except StopAsyncIteration:
                        pass
                    except (SubscriptionError, TimeoutError) as exc:
                        # The response is committed. Report the failure without
                        # switching accounts or appending a completion marker.
                        failure = exc if isinstance(exc, SubscriptionError) else SubscriptionError()
                        payload = json.dumps({"error": failure.public()})
                        await response.write(f"data: {payload}\n\n".encode())
                    except ConnectionError:
                        return response
                    await response.write_eof()
                    return response
            except SubscriptionError as exc:
                last = exc
                if not rotates_account(ModelProviderError(exc.message, status_code=exc.status)):
                    break
        failure = last or SubscriptionError()
        return web.json_response({"error": failure.public()}, status=failure.status, headers=failure.headers())
    except TimeoutError:
        return _error("Subscription request timed out", 502, err_type="upstream_timeout")
    except Exception:
        logger.warning("LLM gateway native subscription request failed")
        return _error("Subscription request could not complete", 502, err_type="upstream_error")


async def handle_chat_completions(request: "web.Request") -> "web.Response":
    """Forward one OpenAI chat-completions call to a registry provider.

    Stateless and generic: resolve ``<provider>`` from the ``model``
    field against the providers registry, inject that provider's stored
    api_key, POST the (lightly rewritten) body to its
    ``/chat/completions``, and relay the response. Never raises — every
    failure path returns a JSON error.
    """
    from aiohttp import web as _web

    # ── Parse body ──────────────────────────────────────────────────
    try:
        body = await request.json() if request.can_read_body else {}
    except Exception:  # noqa: BLE001 — malformed JSON is a client error
        return _error("request body must be valid JSON", 400,
                      err_type="invalid_request_error")
    if not isinstance(body, dict):
        return _error("request body must be a JSON object", 400,
                      err_type="invalid_request_error")

    # ── Resolve provider:model ──────────────────────────────────────
    model_field = str(body.get("model") or "").strip()
    if ":" not in model_field:
        return _error(
            "`model` must be in '<provider>:<model_id>' format "
            "(e.g. 'local:claude-haiku-4-5'); no default provider is assumed",
            400, err_type="invalid_request_error",
        )
    provider_name, model_id = model_field.split(":", 1)
    provider_name = provider_name.strip()
    model_id = model_id.strip()
    if not provider_name or not model_id:
        return _error(
            "`model` must be in '<provider>:<model_id>' format — both the "
            "provider and the model id are required",
            400, err_type="invalid_request_error",
        )

    # ── Look the provider up in the registry ────────────────────────
    db = gateway_db(request)
    if db is None:
        return _error("provider registry unavailable", 503,
                      err_type="service_unavailable")
    rows = await db.list_providers()
    provider_row = next(
        (r for r in rows if r.get("name") == provider_name), None,
    )
    if provider_row is None:
        return _error(f"provider '{provider_name}' is not configured", 404,
                      err_type="invalid_request_error")
    if not bool(provider_row.get("enabled", True)):
        return _error(f"provider '{provider_name}' is disabled", 400,
                      err_type="invalid_request_error")

    outbound = {**body, "model": model_id, "stream": body.get("stream") is True}
    metadata = provider_row.get("metadata") or {}
    if metadata.get("access") == "subscription" and not metadata.get("subscription_remote"):
        return await _subscription_reply(request, db, provider_row, rows, outbound)

    base_url = (provider_row.get("base_url") or "").strip()
    if not base_url:
        # Genericity: the base_url IS the integration; we never guess a
        # fallback URL. A provider row without one is misconfigured.
        return _error(f"provider '{provider_name}' has no base_url configured",
                      502, err_type="provider_config_error")
    api_key = provider_row.get("api_key") or ""

    # ── Build the outbound request ──────────────────────────────────
    # ``base_url`` already includes the API path prefix (e.g. ``/v1``) when
    # the provider needs one; we only append the resource. Strip a single
    # trailing slash so ``.../v1`` and ``.../v1/`` both yield one ``/``.
    url = f"{base_url.rstrip('/')}/chat/completions"
    # Copy the caller's body untouched except the two fields we own:
    # ``model`` (bare id, prefix stripped) and ``stream``: a caller that asks
    # for ``stream: true`` gets the provider's server-sent events relayed as
    # they arrive; anything else is a single JSON answer.
    streaming = outbound["stream"]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if streaming:
        return await _relay_stream(request, url, outbound, headers,
                                   provider_name, model_field)

    # ── Forward + relay ─────────────────────────────────────────────
    timeout = _timeout_seconds()
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=outbound, headers=headers)
    except httpx.TimeoutException:
        elog("llm_gateway.timeout", level="warning",
             provider=provider_name, model=model_field, timeout_s=timeout)
        return _error(
            f"upstream provider '{provider_name}' timed out after {timeout}s",
            502, err_type="upstream_timeout",
        )
    except Exception as exc:  # noqa: BLE001 — connection/transport failure
        elog("llm_gateway.connect_error", level="warning",
             provider=provider_name, model=model_field, error=str(exc))
        return _error(
            f"could not reach upstream provider '{provider_name}': {exc}",
            502, err_type="upstream_unreachable",
        )

    latency_ms = round((time.monotonic() - t0) * 1000, 1)
    status = resp.status_code

    # Try to parse the upstream JSON once; reused for both success and
    # error relays.
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001 — upstream sent non-JSON
        payload = None

    if 200 <= status < 300 and payload is not None:
        elog("llm_gateway.ok", level="info", provider=provider_name,
             model=model_field, upstream_status=status, latency_ms=latency_ms)
        # Relay the upstream JSON verbatim (choices/usage/etc.) with its
        # own status code.
        return _web.json_response(payload, status=status)

    # Non-2xx, or a 2xx that wasn't JSON: relay a clean error carrying the
    # upstream status + a truncated copy of the upstream body (never the
    # api_key — headers are not echoed).
    body_text = (resp.text or "")[:_ERR_BODY_CAP]
    elog("llm_gateway.upstream_error", level="warning", provider=provider_name,
         model=model_field, upstream_status=status, latency_ms=latency_ms)
    return _error(
        f"upstream provider '{provider_name}' returned HTTP {status}",
        status if status >= 400 else 502,
        err_type="upstream_error",
        upstream_status=status,
        upstream_body=body_text,
    )
