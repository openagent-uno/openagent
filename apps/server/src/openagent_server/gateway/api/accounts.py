"""Accounts REST API — who is actually serving this agent's models.

GET /api/accounts  → { "providers": [ { provider, accounts: [...] } ] }

A model row says *which* model answers; it says nothing about *whose*
subscription pays for it. On a subscription-backed deployment that is the
question the operator actually has: which account is serving traffic, is it
rate-limited right now, and how much of its window is left. Nothing exposed
that, so the answer lived in `kubectl exec … curl localhost:8787/health`.

Two sources, merged behind one endpoint:

* **Subscription proxies.** A provider whose ``base_url`` points at a
  sub-proxy (Claude, Codex, anything speaking the same shape) exposes its
  accounts on ``<base>/health``. We probe it and pass the accounts through.
  Discovery is by URL, not by provider NAME — nothing here knows the word
  "codex", so a new proxy works without a code change.
* **OpenAgent's own credential pool.** When a provider declares
  ``metadata.accounts``, :mod:`openagent_core.models.credential_pool` rotates over them
  and tracks each one's health. That pool is in-process, so it is read
  directly rather than over HTTP.

The honest part: **quota is reported only when the upstream reports it.**
The Codex proxy returns a real ``used_percent`` against a real window; the
Claude proxy returns only "limited / not limited", because Anthropic does
not tell it more — it learns an account is spent by being told 429. So
``quota`` is ``null`` for those accounts and the client must say "not
reported" rather than draw a meter it invented. A fabricated headroom number
on this screen is worse than no number: it is the one an operator would plan
around.

Fail-soft throughout. A proxy that is down, slow, or not a proxy at all
yields ``reachable: false`` and an empty account list — never a 500, and
never a stall: the probes run concurrently under a tight timeout, because
this endpoint sits behind a UI that must paint.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from aiohttp import web

from openagent_server.gateway.api._common import gateway_db as _db

# A dead proxy must not hold the panel hostage. Short, and the probes run
# concurrently, so total latency is one timeout rather than N.
_PROBE_TIMEOUT_S = 2.5

# Fields copied out of a proxy's account entry. An explicit allowlist: the
# health payload is another program's shape and may grow fields we would
# rather not blindly relay to a client.
_ACCOUNT_FIELDS = (
    "id", "name", "priority", "plan", "managed",
    "limited", "limited_until_ms", "expires_at_ms", "has_refresh_token", "enabled",
)

_QUOTA_FIELDS = (
    "plan", "active_limit",
    "primary_used_percent", "primary_window_minutes", "primary_reset_after_s",
    "secondary_used_percent", "secondary_window_minutes", "secondary_reset_after_s",
    "credits_balance",
)

# Pool metrics worth showing beside the accounts: how loaded the proxy is and
# whether it has been switching accounts (which is what rate-limiting looks
# like from the outside).
_METRIC_FIELDS = (
    "active", "queued", "rate_limited", "account_rate_limited",
    "account_switches", "upstream_errors",
)


def _health_url(base_url: str) -> str | None:
    """Turn a provider ``base_url`` into its proxy health URL.

    The base_url is an OpenAI-compatible endpoint (``…/v1``); the health
    endpoint sits at the root beside it. Only loopback/private-looking HTTP
    endpoints are probed — a provider pointing at a vendor's public API is
    not a proxy we own, and must never be poked with an unexpected request.
    """
    if not base_url or not isinstance(base_url, str):
        return None
    url = base_url.strip().rstrip("/")
    if not url.startswith("http://"):
        # A sub-proxy we host is reached over plain HTTP on the pod network.
        # An https:// base_url is somebody else's API — leave it alone.
        return None
    if url.endswith("/v1"):
        url = url[: -len("/v1")]
    return f"{url}/health"


def _redact_url(url: str) -> str:
    """Strip any userinfo from a URL before it leaves the gateway.

    ``http://user:token@host/v1`` is a legal base_url and some deployments
    carry the credential there. This value is echoed to a UI, so the
    credential must not ride along — the host is the useful part.
    """
    if not url or "@" not in url:
        return url or ""
    try:
        scheme, rest = url.split("://", 1)
    except ValueError:
        return url
    if "@" not in rest:
        return url
    _userinfo, host = rest.rsplit("@", 1)
    return f"{scheme}://***@{host}"


def _pick(src: Any, fields: tuple[str, ...]) -> dict:
    if not isinstance(src, dict):
        return {}
    return {k: src[k] for k in fields if k in src}


# Signs that an account's sign-in no longer works, as opposed to a usage
# limit. Read from the proxy's own error text only to classify it; the text
# itself is not relayed.
_AUTH_ERROR_MARKERS = (
    "invalid_grant", "refresh_token", "refresh token", "session has ended",
    "log in again", "login again", "unauthorized", "authentication", "401",
)


def account_status(raw: dict, now_ms: int) -> str:
    """``ok``, ``rate_limited`` or ``auth_expired`` for one account entry."""
    error = " ".join(str(raw.get(key) or "") for key in ("last_error", "error", "reason")).lower()
    expires = raw.get("expires_at_ms")
    expired_without_refresh = (isinstance(expires, (int, float)) and expires < now_ms
                               and raw.get("has_refresh_token") is False)
    if raw.get("auth_expired") is True or expired_without_refresh or any(m in error for m in _AUTH_ERROR_MARKERS):
        return "auth_expired"
    until = raw.get("limited_until_ms")
    if raw.get("limited") and (not isinstance(until, (int, float)) or until > now_ms):
        return "rate_limited"
    return "ok"


def provider_status(entry: dict) -> str:
    """One word for a provider: the best state among its accounts."""
    if not entry.get("reachable"):
        return "unreachable"
    states = {account.get("status") for account in entry.get("accounts") or []}
    if not states or "ok" in states:
        return "ok"
    return "rate_limited" if "rate_limited" in states else "auth_expired"


def _normalise_account(raw: Any, now_ms: int | None = None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = _pick(raw, _ACCOUNT_FIELDS)
    if not out.get("id") and not out.get("name"):
        return None
    quota = _pick(raw.get("quota"), _QUOTA_FIELDS)
    # An empty dict would render as "quota known, all zeroes". Null means
    # "this upstream does not report quota", which is a different claim.
    out["quota"] = quota or None
    out["source"] = "proxy"
    import time
    out["status"] = account_status(raw, int(time.time() * 1000) if now_ms is None else now_ms)
    return out


async def _probe(session, provider: dict) -> dict:
    """Ask one provider's proxy who is serving it. Never raises."""
    name = provider.get("name") or "?"
    base_url = provider.get("base_url") or ""
    entry = {
        "provider": name,
        "framework": provider.get("framework"),
        "base_url": _redact_url(base_url),
        "enabled": bool(provider.get("enabled", True)),
        "reachable": False,
        "accounts": [],
        "metrics": None,
        "error": None,
        # True when this endpoint is a subscription service that reports accounts.
        "sign_in": False,
    }
    url = _health_url(base_url)
    if url is None:
        entry["error"] = "not a local proxy endpoint"
        return entry
    try:
        async with session.get(url) as resp:
            if resp.status != 200:
                entry["error"] = f"health returned {resp.status}"
                return entry
            payload = await resp.json(content_type=None)
    except Exception as exc:  # noqa: BLE001 — a down proxy is data, not a fault
        entry["error"] = str(exc)[:200]
        return entry

    if not isinstance(payload, dict):
        entry["error"] = "health payload was not an object"
        return entry
    raw_accounts = payload.get("accounts")
    if not isinstance(raw_accounts, list):
        # A subscription service may publish its accounts only on its
        # authenticated admin surface. Ask there with this provider's own key.
        admin = await _admin_diagnostics(session, provider)
        if admin is not None:
            payload, raw_accounts = admin, admin.get("accounts")
    if not isinstance(raw_accounts, list):
        # Reachable, but not a proxy that fronts accounts (a plain llama.cpp
        # health endpoint, say). Reachable is still worth reporting.
        entry["reachable"] = True
        entry["error"] = "endpoint reports no accounts"
        return entry
    entry["sign_in"] = True

    entry["reachable"] = True
    entry["accounts"] = [a for a in map(_normalise_account, raw_accounts) if a]
    entry["metrics"] = _pick(payload.get("metrics"), _METRIC_FIELDS) or None
    return entry


def _admin_url(base_url: str, path: str) -> str | None:
    """The admin URL beside a local subscription service's ``/v1`` endpoint."""
    health = _health_url(base_url)
    return None if health is None else health[: -len("/health")] + path


def _admin_headers(provider: dict) -> dict:
    key = provider.get("api_key")
    return {"Authorization": f"Bearer {key}"} if isinstance(key, str) and key else {}


async def _admin_diagnostics(session, provider: dict) -> dict | None:
    url = _admin_url(provider.get("base_url") or "", "/admin/diagnostics")
    if url is None:
        return None
    try:
        async with session.get(url, headers=_admin_headers(provider)) as resp:
            if resp.status != 200:
                return None
            payload = await resp.json(content_type=None)
    except Exception:  # noqa: BLE001 - no admin surface is not a fault
        return None
    return payload if isinstance(payload, dict) and isinstance(payload.get("accounts"), list) else None


# ── Sign-in to a subscription service ──────────────────────────────────
#
# A subscription service signs an account in with a browser flow it owns:
# ``POST <root>/admin/oauth/start`` returns the page to open and an opaque
# state, and ``POST <root>/admin/oauth/complete`` redeems the code that page
# hands back. These two routes only drive that flow for a provider whose
# endpoint is a local service; no credential passes through or is stored here.

_SIGN_IN_TIMEOUT_S = 30.0


def _parse_provider_id(request) -> int | None:
    try:
        return int(request.match_info.get("id") or "")
    except ValueError:
        return None


def _code_from(value: str) -> str:
    """The sign-in code, also when the person pasted the whole redirected URL."""
    value = value.strip()
    if value.lower().startswith(("http://", "https://")):
        from urllib.parse import parse_qs, urlsplit

        code = parse_qs(urlsplit(value).query).get("code")
        if code and code[0].strip():
            return code[0].strip()
    return value


async def _sign_in_call(request, path: str, body: dict | None):
    from aiohttp import web
    import aiohttp

    db = _db(request)
    pid = _parse_provider_id(request)
    if db is None or pid is None:
        return None, web.json_response({"error": "invalid provider id"}, status=400)
    provider = await db.get_provider(pid)
    if provider is None:
        return None, web.json_response({"error": f"Provider id={pid} not found"}, status=404)
    if (provider.get("metadata") or {}).get("access") == "subscription":
        from openagent_server.provider_management import for_request
        admin, context = await for_request(request)
        try:
            payload = await admin.subscription(context, pid, "complete" if path.endswith("complete") else "start", body)
            return (provider, payload), None
        except (ValueError, LookupError) as exc:
            return None, web.json_response({"error": str(exc)}, status=400)
    url = _admin_url(provider.get("base_url") or "", path)
    if url is None:
        return None, web.json_response(
            {"error": "This provider is not a local subscription service"}, status=400)
    try:
        timeout = aiohttp.ClientTimeout(total=_SIGN_IN_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=body or {}, headers=_admin_headers(provider)) as resp:
                payload = await resp.json(content_type=None)
                status = resp.status
    except Exception as exc:  # noqa: BLE001
        return None, web.json_response(
            {"error": f"The subscription service did not answer: {type(exc).__name__}"}, status=502)
    if status == 404:
        return None, web.json_response(
            {"error": "This subscription service does not support sign-in from here"}, status=400)
    if status != 200 or not isinstance(payload, dict):
        detail = payload.get("detail") if isinstance(payload, dict) else None
        return None, web.json_response(
            {"error": str(detail)[:300] if detail else f"The subscription service answered {status}"},
            status=400 if 400 <= status < 500 else 502)
    return (provider, payload), None


async def handle_sign_in_start(request):
    """POST /api/providers/{id}/sign-in/start — begin a subscription sign-in."""
    from aiohttp import web

    result, problem = await _sign_in_call(request, "/admin/oauth/start", None)
    if problem is not None:
        return problem
    _provider, payload = result
    url = payload.get("authorize_url")
    state = payload.get("state")
    if not isinstance(url, str) or not url.startswith("https://") or not isinstance(state, str) or not state:
        return web.json_response({"error": "The subscription service returned no sign-in page"}, status=502)
    return web.json_response({
        "authorize_url": url, "state": state,
        "expires_in": payload.get("expires_in") if isinstance(payload.get("expires_in"), int) else None,
    })


async def handle_sign_in_complete(request):
    """POST /api/providers/{id}/sign-in/complete — body ``{state, code, name?, priority?}``."""
    from aiohttp import web

    try:
        body = await request.json() if request.can_read_body else {}
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    state = str(body.get("state") or "").strip()
    code = _code_from(str(body.get("code") or ""))
    if not state or not code:
        return web.json_response({"error": "state and code are required"}, status=400)
    forward = {"state": state, "code": code}
    if isinstance(body.get("name"), str) and body["name"].strip():
        forward["name"] = body["name"].strip()[:80]
    if isinstance(body.get("priority"), int) and not isinstance(body.get("priority"), bool):
        forward["priority"] = body["priority"]
    result, problem = await _sign_in_call(request, "/admin/oauth/complete", forward)
    if problem is not None:
        return problem
    provider, payload = result
    import time

    account = _normalise_account(payload.get("account"), int(time.time() * 1000))
    # A new account can change what the provider's models accept.
    refreshed = None
    try:
        from openagent_server.provider_management import for_request

        admin, context = await for_request(request)
        refreshed = await admin.refresh_capabilities(context, provider["id"])
    except Exception:  # noqa: BLE001 - the sign-in itself succeeded
        refreshed = None
    return web.json_response({"ok": True, "account": account, "refreshed": refreshed})


def _pool_accounts(provider_name: str) -> list[dict]:
    """Accounts from OpenAgent's own rotation pool, if this provider has one.

    Inert on almost every deployment (a pool only exists at >= 2 configured
    accounts), so this usually returns []. Kept because when it IS configured
    it is the same question with a different answer source, and the client
    should not have to know which.
    """
    try:
        from openagent_core.models.credential_pool import _POOLS  # noqa: PLC0415

        pool = _POOLS.get(provider_name)
        if pool is None:
            return []
        return pool.snapshot()
    except Exception:  # noqa: BLE001
        return []


async def handle_list(request):
    """GET /api/accounts — the accounts serving each enabled provider."""
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "No database configured"}, status=503)

    providers = await db.list_providers()
    native = [p for p in providers if (p.get("metadata") or {}).get("access") == "subscription"]
    live = [p for p in providers if p.get("enabled") and p not in native]

    import aiohttp

    timeout = aiohttp.ClientTimeout(total=_PROBE_TIMEOUT_S)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        entries = await asyncio.gather(
            *(_probe(session, p) for p in live), return_exceptions=True
        )

    out: list[dict] = []
    for provider, entry in zip(live, entries):
        if isinstance(entry, BaseException):
            entry = {
                "provider": provider.get("name"),
                "base_url": _redact_url(provider.get("base_url") or ""),
                "enabled": True,
                "reachable": False,
                "accounts": [],
                "metrics": None,
                "error": str(entry)[:200],
            }
        pooled = [{**account, "status": "auth_expired" if account.get("dead")
                   else "rate_limited" if account.get("limited") else "ok"}
                  for account in _pool_accounts(provider.get("name") or "")]
        if pooled:
            entry["accounts"] = list(entry["accounts"]) + pooled
        entry["provider_id"] = provider.get("id")
        entry["status"] = provider_status(entry) if entry.get("accounts") or entry.get("reachable") else "unreachable"
        out.append(entry)

    if native:
        from openagent_server.provider_management import for_request
        admin, context = await for_request(request)
        import time
        import httpx
        slots = asyncio.Semaphore(4)
        async def native_entry(provider):
            async with slots:
                try:
                    accounts = await admin.subscription(context, provider["id"], "accounts")
                    capabilities = await admin.subscription(context, provider["id"], "capabilities")
                    accounts = [_normalise_account(a, int(time.time() * 1000)) for a in accounts]
                    accounts = [a for a in accounts if a is not None]
                    entry = {"provider": provider["name"], "provider_id": provider["id"],
                             "enabled": provider["enabled"], "reachable": True,
                             "sign_in": capabilities.get("sign_in") is True,
                             "accounts": accounts, "metrics": None, "error": None}
                    entry["status"] = provider_status(entry)
                    return entry
                except (ValueError, OSError, httpx.HTTPError):
                    return {"provider": provider["name"], "provider_id": provider["id"],
                            "enabled": provider["enabled"], "reachable": False,
                            "sign_in": not (provider.get("metadata") or {}).get("subscription_remote"),
                            "accounts": [], "metrics": None, "status": "unreachable",
                            "error": "Subscription adapter unavailable"}
        out.extend(await asyncio.gather(*(native_entry(provider) for provider in native)))
    return web.json_response({"providers": out})


async def handle_update_account(request):
    from aiohttp import web
    from openagent_server.provider_management import for_request
    admin, context = await for_request(request)
    try:
        body = await request.json()
        result = await admin.subscription(context, int(request.match_info["id"]), "update_account",
                                          {**body, "id": request.match_info["account_id"]})
        return web.json_response(result)
    except (ValueError, LookupError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
