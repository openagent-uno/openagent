"""OpenAI-compatible HTTP front. OpenAgent registers this as a ``local`` model
via ``base_url=http://HOST:PORT/v1`` and talks to it like any OpenAI server.

Endpoints: ``POST /v1/chat/completions`` (stream + non-stream),
``GET /v1/models``, ``GET /health``.
"""

from __future__ import annotations

import json
import random
import threading
import time
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import translate
from .auth import AccountToken, NoAvailableAccountError, TokenManager
from .cc_anthropic import AnthropicHTTPError, ClaudeCodeClient
from .config import settings

app = FastAPI(title="claude-sub-proxy", version="0.1.0")

_token_mgr = TokenManager(settings.creds_file)
_client = ClaudeCodeClient(
    _token_mgr.get_token,
    transport=settings.transport,
    impersonate=settings.impersonate,
    timeout=settings.request_timeout,
)
_upstream_slots = threading.BoundedSemaphore(max(1, settings.upstream_max_concurrency))
_queue_slots = threading.BoundedSemaphore(
    max(1, settings.upstream_max_concurrency + settings.upstream_max_queue)
)
_pace_lock = threading.Lock()
_next_upstream_at = 0.0
_metrics_lock = threading.Lock()
_metrics = {
    "accepted": 0,
    "completed": 0,
    "released": 0,
    "active": 0,
    "queued": 0,
    "rejected": 0,
    "rate_limited": 0,
    "upstream_errors": 0,
    "queue_timeouts": 0,
    "account_rate_limited": 0,
    "account_switches": 0,
    "last_error": "",
    "last_error_at": 0.0,
    "max_queue_wait_s": 0.0,
}

_RATE_LIMIT_MARKERS = (
    "rate_limit",
    "rate limit",
    "rate-limit",
    "rate limiting",
    "rate-limiting",
    "model provider is rate-limiting requests",
    "please wait a moment and try again",
)


class UpstreamOverloaded(Exception):
    pass


def _set_last_error(message: str) -> None:
    with _metrics_lock:
        _metrics["last_error"] = message
        _metrics["last_error_at"] = time.time()


def _metric_add(name: str, delta: int = 1) -> None:
    with _metrics_lock:
        _metrics[name] = int(_metrics.get(name, 0)) + delta


def _metrics_snapshot() -> dict:
    with _metrics_lock:
        snapshot = dict(_metrics)
    snapshot["last_error_at"] = round(float(snapshot["last_error_at"]), 3)
    snapshot["max_queue_wait_s"] = round(float(snapshot["max_queue_wait_s"]), 3)
    return snapshot


def _record_queue_wait(wait_s: float) -> None:
    with _metrics_lock:
        _metrics["max_queue_wait_s"] = max(float(_metrics["max_queue_wait_s"]), wait_s)


@contextmanager
def _upstream_lease():
    admission_timeout = max(0.0, settings.upstream_admission_timeout)
    queue_timeout = max(1.0, settings.upstream_queue_timeout)
    if not _queue_slots.acquire(timeout=admission_timeout):
        _metric_add("rejected")
        msg = (
            "upstream queue is full "
            f"(active={settings.upstream_max_concurrency}, "
            f"queue={settings.upstream_max_queue})"
        )
        _set_last_error(msg)
        raise UpstreamOverloaded(msg)

    queue_registered = False
    upstream_acquired = False
    queued_at = time.monotonic()
    try:
        with _metrics_lock:
            _metrics["accepted"] += 1
            _metrics["queued"] += 1
        queue_registered = True

        if not _upstream_slots.acquire(timeout=queue_timeout):
            _metric_add("queue_timeouts")
            msg = f"upstream queue timed out after {queue_timeout:.0f}s"
            _set_last_error(msg)
            raise UpstreamOverloaded(msg)

        upstream_acquired = True
        wait_s = time.monotonic() - queued_at
        with _metrics_lock:
            _metrics["queued"] -= 1
            _metrics["active"] += 1
        queue_registered = False
        _record_queue_wait(wait_s)

        _pace_upstream()
        yield
        _metric_add("completed")
    finally:
        if upstream_acquired:
            with _metrics_lock:
                _metrics["active"] -= 1
                _metrics["released"] += 1
            _upstream_slots.release()
        elif queue_registered:
            with _metrics_lock:
                _metrics["queued"] -= 1
        _queue_slots.release()


def _check_auth(authorization: Optional[str]) -> None:
    if settings.api_key and authorization != f"Bearer {settings.api_key}":
        raise HTTPException(status_code=401, detail="invalid api key")


def _pace_upstream() -> None:
    global _next_upstream_at
    min_interval = max(0.0, settings.upstream_min_interval)
    if min_interval <= 0:
        return
    with _pace_lock:
        now = time.monotonic()
        sleep_s = max(0.0, _next_upstream_at - now)
        _next_upstream_at = max(_next_upstream_at, now) + min_interval
    if sleep_s:
        time.sleep(sleep_s)


def _contains_rate_limit_marker(value: object) -> bool:
    text = str(value).lower()
    return any(marker in text for marker in _RATE_LIMIT_MARKERS)


def _is_rate_limit(exc: AnthropicHTTPError) -> bool:
    if getattr(exc, "status", None) == 429:
        return True
    body = getattr(exc, "body", "")
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            if _contains_rate_limit_marker(err.get("type", "")):
                return True
            if _contains_rate_limit_marker(err.get("message", "")):
                return True
    return _contains_rate_limit_marker(body)


def _is_overloaded(exc: AnthropicHTTPError) -> bool:
    """Anthropic HTTP 529 / ``overloaded_error`` — transient global capacity.

    Distinct from a rate limit: it is not account-specific, so the caller should
    back off and retry the SAME account rather than rotating/excluding accounts
    (every account hits the same overloaded upstream). Without this, a transient
    529 was raised straight through to the caller (e.g. surfaced raw in Telegram).
    """
    if getattr(exc, "status", None) == 529:
        return True
    body = getattr(exc, "body", "")
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            if "overload" in str(err.get("type", "")).lower():
                return True
            if "overload" in str(err.get("message", "")).lower():
                return True
    return "overloaded" in str(body).lower()


def _rate_limit_sleep(attempt: int) -> float:
    base = max(0.0, settings.rate_limit_backoff)
    cap = max(base, settings.rate_limit_max_backoff)
    return min(cap, base * (2 ** attempt)) + random.uniform(0.0, 2.0)


def _cool_down_upstream(wait_s: float) -> None:
    global _next_upstream_at
    wait_s = max(0.0, wait_s)
    if wait_s <= 0:
        return
    with _pace_lock:
        _next_upstream_at = max(_next_upstream_at, time.monotonic() + wait_s)


def _account_rate_limit_reason(exc: AnthropicHTTPError) -> str:
    body = getattr(exc, "body", "")
    if isinstance(body, dict):
        try:
            return json.dumps(body)[:500]
        except Exception:
            return str(body)[:500]
    return str(body)[:500]


def _mark_account_rate_limited(account: AccountToken, exc: AnthropicHTTPError) -> None:
    cooldown_s = max(0.0, settings.account_rate_limit_cooldown)
    _token_mgr.mark_rate_limited(
        account.id,
        cooldown_s,
        reason=_account_rate_limit_reason(exc),
    )
    _metric_add("account_rate_limited")
    print(
        f"upstream rate limited account {account.name!r}; "
        f"cooling that account for {cooldown_s:.1f}s",
        flush=True,
    )


def _no_available_account_payload(exc: NoAvailableAccountError) -> dict:
    message = str(exc)
    if exc.retry_after_ms:
        retry_after_s = max(1, int((exc.retry_after_ms + 999) // 1000))
        message = f"{message} Retry after about {retry_after_s}s."
    return {
        "error": {
            "message": message,
            "type": "no_available_account",
            "code": 429,
        }
    }


def _complete_with_pacing(payload: dict) -> dict:
    attempts = max(0, settings.rate_limit_retries) + 1
    last_rate_limit: Optional[AnthropicHTTPError] = None
    last_overloaded: Optional[AnthropicHTTPError] = None
    no_available: Optional[NoAvailableAccountError] = None
    for attempt in range(attempts):
        excluded_accounts: set[str] = set()
        while True:
            try:
                account = _token_mgr.select_account(exclude_ids=excluded_accounts)
            except NoAvailableAccountError as exc:
                no_available = exc
                break
            if excluded_accounts:
                _metric_add("account_switches")
            try:
                with _upstream_lease():
                    response = _client.complete(payload, token=account.token)
                _token_mgr.mark_success(account.id)
                return response
            except AnthropicHTTPError as exc:
                if _is_rate_limit(exc):
                    last_rate_limit = exc
                    _metric_add("rate_limited")
                    _mark_account_rate_limited(account, exc)
                    excluded_accounts.add(account.id)
                    continue
                if _is_overloaded(exc):
                    # Global upstream overload (529, not a per-account rate limit):
                    # rotating accounts is futile. Back off, retry the SAME account.
                    last_overloaded = exc
                    _metric_add("upstream_overloaded")
                    break
                _metric_add("upstream_errors")
                _set_last_error(str(exc))
                raise
            except Exception as exc:
                _metric_add("upstream_errors")
                _set_last_error(str(exc))
                raise

        if attempt >= attempts - 1:
            wait_s = max(settings.rate_limit_backoff, settings.rate_limit_max_backoff)
            _cool_down_upstream(wait_s)
            if last_overloaded is not None:
                _set_last_error(str(last_overloaded))
                print(
                    f"upstream overloaded; cooling down {wait_s:.1f}s "
                    "(retries exhausted)",
                    flush=True,
                )
                raise UpstreamOverloaded(str(last_overloaded))
            if last_rate_limit:
                _set_last_error(str(last_rate_limit))
                print(
                    f"all available accounts rate limited; cooling down {wait_s:.1f}s "
                    "(retries exhausted)",
                    flush=True,
                )
                raise last_rate_limit
            if no_available:
                _set_last_error(str(no_available))
                raise no_available
            raise NoAvailableAccountError("No available Claude OAuth accounts.")

        wait_s = _rate_limit_sleep(attempt)
        _cool_down_upstream(wait_s)
        print(
            f"upstream busy ({'overloaded' if last_overloaded is not None else 'rate limited'}); "
            f"sleeping {wait_s:.1f}s (retry {attempt + 1}/{attempts - 1})",
            flush=True,
        )
        time.sleep(wait_s)
    raise RuntimeError("unreachable")


def _stream_with_pacing(payload: dict):
    attempts = max(0, settings.rate_limit_retries) + 1
    last_rate_limit: Optional[AnthropicHTTPError] = None
    last_overloaded: Optional[AnthropicHTTPError] = None
    no_available: Optional[NoAvailableAccountError] = None
    for attempt in range(attempts):
        excluded_accounts: set[str] = set()
        while True:
            yielded = False
            try:
                account = _token_mgr.select_account(exclude_ids=excluded_accounts)
            except NoAvailableAccountError as exc:
                no_available = exc
                break
            if excluded_accounts:
                _metric_add("account_switches")
            try:
                with _upstream_lease():
                    for chunk in _client.stream(payload, token=account.token):
                        yielded = True
                        yield chunk
                _token_mgr.mark_success(account.id)
                return
            except AnthropicHTTPError as exc:
                if yielded:
                    # Already streamed chunks — cannot safely retry/rotate.
                    _metric_add("upstream_errors")
                    _set_last_error(str(exc))
                    raise
                if _is_rate_limit(exc):
                    last_rate_limit = exc
                    _metric_add("rate_limited")
                    _mark_account_rate_limited(account, exc)
                    excluded_accounts.add(account.id)
                    continue
                if _is_overloaded(exc):
                    # Global upstream overload (529) before any chunk streamed:
                    # back off and retry the SAME account (no exclude).
                    last_overloaded = exc
                    _metric_add("upstream_overloaded")
                    break
                _metric_add("upstream_errors")
                _set_last_error(str(exc))
                raise
            except Exception as exc:
                _metric_add("upstream_errors")
                _set_last_error(str(exc))
                raise

        if attempt >= attempts - 1:
            wait_s = max(settings.rate_limit_backoff, settings.rate_limit_max_backoff)
            _cool_down_upstream(wait_s)
            if last_overloaded is not None:
                _set_last_error(str(last_overloaded))
                print(
                    f"upstream overloaded (stream); cooling down {wait_s:.1f}s "
                    "(retries exhausted)",
                    flush=True,
                )
                raise UpstreamOverloaded(str(last_overloaded))
            if last_rate_limit:
                _set_last_error(str(last_rate_limit))
                print(
                    f"all available stream accounts rate limited; cooling down {wait_s:.1f}s "
                    "(retries exhausted)",
                    flush=True,
                )
                raise last_rate_limit
            if no_available:
                _set_last_error(str(no_available))
                raise no_available
            raise NoAvailableAccountError("No available Claude OAuth accounts.")

        wait_s = _rate_limit_sleep(attempt)
        _cool_down_upstream(wait_s)
        print(
            f"upstream busy (stream, {'overloaded' if last_overloaded is not None else 'rate limited'}); "
            f"sleeping {wait_s:.1f}s (retry {attempt + 1}/{attempts - 1})",
            flush=True,
        )
        time.sleep(wait_s)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "transport": _client.transport,
        "cc_version": _client.cc_version,
        "settings": {
            "request_timeout": settings.request_timeout,
            "stream_chunk_watchdog": "disabled",
            "upstream_max_concurrency": settings.upstream_max_concurrency,
            "upstream_max_queue": settings.upstream_max_queue,
            "upstream_admission_timeout": settings.upstream_admission_timeout,
            "upstream_queue_timeout": settings.upstream_queue_timeout,
            "upstream_min_interval": settings.upstream_min_interval,
            "rate_limit_retries": settings.rate_limit_retries,
            "rate_limit_backoff": settings.rate_limit_backoff,
            "rate_limit_max_backoff": settings.rate_limit_max_backoff,
            "account_rate_limit_cooldown": settings.account_rate_limit_cooldown,
        },
        "metrics": _metrics_snapshot(),
        "accounts": _token_mgr.account_statuses(),
    }


@app.get("/admin/accounts")
def admin_list_accounts(authorization: Optional[str] = Header(default=None)):
    """List all accounts with their current rate-limit status."""
    _check_auth(authorization)
    return {"accounts": _token_mgr.account_statuses()}


@app.post("/admin/accounts/{account_id}/reset")
def admin_reset_account(account_id: str, authorization: Optional[str] = Header(default=None)):
    """Reset the rate-limit cooldown for a specific account (by id or name).
    Also resets limited_until_ms=0 in the credentials file so the reset
    survives a proxy restart.
    """
    _check_auth(authorization)
    with _token_mgr._lock:
        store = _token_mgr._load_store_unlocked()
        account = _token_mgr._find_account_unlocked(account_id)
        if not account:
            # Try unmanaged env accounts
            env_key = f"env:{account_id}"
            _token_mgr._unmanaged_limited_until_ms.pop(env_key, None)
            return {"reset": True, "id": env_key, "note": "unmanaged env account cooldown cleared"}
        account["limited_until_ms"] = 0
        account["last_error"] = ""
        _token_mgr._save_store_unlocked(store)
    return {
        "reset": True,
        "id": account.get("id"),
        "name": account.get("name"),
        "limited": False,
    }


@app.post("/admin/accounts/{account_id}/reset-cooldown")
def admin_reset_cooldown(account_id: str, authorization: Optional[str] = Header(default=None)):
    """Alias for /admin/accounts/{id}/reset."""
    return admin_reset_account(account_id, authorization)


@app.get("/v1/models")
def list_models():
    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {"id": m, "object": "model", "created": now, "owned_by": "anthropic-subscription"}
            for m in settings.models
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    body = await request.json()
    model = body.get("model", "")
    stream = bool(body.get("stream"))
    payload = translate.openai_to_anthropic(
        body,
        default_max_tokens=settings.default_max_tokens,
        max_tools=settings.max_tools,
        model_map=settings.model_map,
    )

    if stream:
        # OpenAI's opt-in for a final usage chunk. A caller that asks for it and
        # is silently given nothing doesn't see an error — it sees a free turn.
        include_usage = bool(
            (body.get("stream_options") or {}).get("include_usage")
        )

        def _gen():
            try:
                for chunk in translate.anthropic_stream_to_openai(
                    _stream_with_pacing(payload), model, include_usage=include_usage,
                ):
                    yield chunk
            except UpstreamOverloaded as exc:
                yield "data: " + json.dumps({
                    "error": {
                        "message": str(exc),
                        "type": "upstream_overloaded",
                        "code": 503,
                    }
                }) + "\n\n"
                yield "data: [DONE]\n\n"
            except NoAvailableAccountError as exc:
                yield "data: " + json.dumps(_no_available_account_payload(exc)) + "\n\n"
                yield "data: [DONE]\n\n"
            except AnthropicHTTPError as exc:
                yield "data: " + json.dumps(_error_payload(exc)) + "\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:
                yield "data: " + json.dumps(_proxy_error_payload(exc)) + "\n\n"
                yield "data: [DONE]\n\n"

        # Starlette iterates this sync generator in a threadpool.
        return StreamingResponse(_gen(), media_type="text/event-stream")

    try:
        resp = await run_in_threadpool(_complete_with_pacing, payload)
    except UpstreamOverloaded as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "message": str(exc),
                    "type": "upstream_overloaded",
                    "code": 503,
                }
            },
        )
    except NoAvailableAccountError as exc:
        return JSONResponse(status_code=429, content=_no_available_account_payload(exc))
    except AnthropicHTTPError as exc:
        status = exc.status if isinstance(exc.status, int) and exc.status >= 400 else 502
        return JSONResponse(status_code=status, content=_error_payload(exc))
    except Exception as exc:
        return JSONResponse(status_code=502, content=_proxy_error_payload(exc))
    return JSONResponse(translate.anthropic_to_openai(resp, model))


def _error_payload(exc: AnthropicHTTPError) -> dict:
    return {
        "error": {
            "message": str(exc.body),
            "type": "upstream_error",
            "code": getattr(exc, "status", None),
        }
    }


def _proxy_error_payload(exc: Exception) -> dict:
    return {
        "error": {
            "message": str(exc),
            "type": "proxy_error",
            "code": 502,
        }
    }
