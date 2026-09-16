"""Standalone support profile selection; never selected by the core."""
from __future__ import annotations
import ipaddress
from urllib.parse import urlparse
from typing import Any
from openagent_core.configuration import runtime_environment
_TRUTHY = {"1", "true", "yes", "on"}
_FALSEY = {"0", "false", "no", "off"}

def _enabled_by_default() -> bool:
    raw = runtime_environment().get("OPENAGENT_LEAN_LOCAL_EVENTS", "1").strip().lower()
    if raw in _FALSEY:
        return False
    return raw in _TRUTHY or not raw


def _scheduled_tasks_enabled_by_default() -> bool:
    raw = runtime_environment().get("OPENAGENT_LEAN_LOCAL_SCHEDULED_TASKS", "1").strip().lower()
    if raw in _FALSEY:
        return False
    return raw in _TRUTHY or not raw


# A model from one of these families is that vendor's model wherever it is
# reached from. Two of our own endpoints are proxies to Anthropic - one on
# 127.0.0.1, one on a *.svc.cluster.local name - so a URL test alone called
# cloud Claude "self-hosted" and handed it the lean local profile.
_CLOUD_MODEL_FAMILIES = (
    "claude", "gpt-", "gpt4", "gpt5", "o1-", "o3-", "o4-",
    "gemini", "grok", "deepseek", "mistral-large", "command-r",
)


def _is_cloud_model_id(runtime_id: str) -> bool:
    model = runtime_id.split(":", 1)[-1].strip().lower()
    return any(family in model for family in _CLOUD_MODEL_FAMILIES)


def _is_local_url(base_url: str | None) -> bool:
    if not base_url:
        return False
    try:
        host = (urlparse(base_url).hostname or "").strip().lower()
        if host in {"localhost", "host.docker.internal"} or host.endswith(".local"):
            return True
        address = ipaddress.ip_address(host)
        # Tailscale hands out 100.64.0.0/10 (CGNAT). Python calls that
        # "shared", not "private", so the one endpoint that really is our own
        # GPU box was the only one being judged remote.
        if address in ipaddress.ip_network("100.64.0.0/10"):
            return True
        if address.version == 6 and address in ipaddress.ip_network("fd7a:115c:a1e0::/48"):
            return True
        return address.is_private
    except (TypeError, ValueError):
        return False


async def _is_pinned_self_hosted(runtime_id: str, db: Any) -> bool:
    """Resolve one explicit runtime pin to a private/self-hosted provider."""
    if db is None:
        return False
    if ":" not in runtime_id:
        return False
    explicit = {
        item.strip()
        for item in runtime_environment().get("OPENAGENT_LOCAL_INFERENCE_MODELS", "").split(",")
        if item.strip()
    }
    if explicit:
        return runtime_id in explicit
    # A cloud model is never self-hosted, whatever it is proxied through.
    if _is_cloud_model_id(runtime_id):
        return False
    provider_name = runtime_id.split(":", 1)[0]
    try:
        row = await db.get_provider_by_name(provider_name, "api-based")
    except Exception:  # noqa: BLE001 - profile detection must never fail a run
        return False
    return bool(row and _is_local_url(row.get("base_url")))


async def should_use_lean_local_event(event: dict[str, Any], db: Any) -> bool:
    """True only for an explicitly pinned event on a self-hosted endpoint."""
    if not _enabled_by_default():
        return False
    runtime_id = str((event or {}).get("model") or "").strip()
    return await _is_pinned_self_hosted(runtime_id, db)


async def should_use_lean_local_scheduled_task(
    task: dict[str, Any], db: Any,
) -> bool:
    """True for an explicitly pinned scheduled task on a self-hosted model.

    Unlike an interactive turn, a scheduled firing has no human available to
    notice a silent provider fallback or a runaway context.  The scheduler
    uses this result for both the compact prompt profile and the hard
    local-only boundary.
    """
    if not _scheduled_tasks_enabled_by_default():
        return False
    runtime_id = str((task or {}).get("model") or "").strip()
    return await _is_pinned_self_hosted(runtime_id, db)



async def select_profile(kind, definition, db):
    if kind == 'event':
        return await should_use_lean_local_event(definition, db)
    if kind == 'scheduled_task':
        return await should_use_lean_local_scheduled_task(definition, db)
    return False
