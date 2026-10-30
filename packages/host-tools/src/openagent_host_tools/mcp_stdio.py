"""Public MCP adapter and trusted, local operator decision dispatch."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from typing import Any
from urllib.parse import urlsplit

from openagent_capability_host.mcp_stdio import MCPStdioServer
from openagent_tool_protocol import HostError, ToolResult
from .chrome_pool import PerPrincipalMCPPool, _chrome_principal_key, _PortLease, _port_is_free, _wait_until_port_free

_PERMISSION_NAMES = {"geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write"}


def _operator_metadata(tool: str, arguments: dict[str, Any], secret: str) -> dict[str, Any]:
    """Sign only a fixed human-decision shape; never copy caller metadata."""
    allowed = {"browser_id", "tabId", "request_id", "action", "origin", "permissions"}
    if not isinstance(arguments, dict) or set(arguments) - allowed:
        raise HostError("invalid_provider_control", "operator control accepts decision fields only")
    action = arguments.get("action")
    if not isinstance(action, str) or (tool, action) not in {("browser_control", "resume"), ("browser_permissions", "grant"), ("browser_permissions", "revoke")}:
        raise HostError("invalid_provider_control", "only browser resume/grant/revoke are operator decisions")
    tab = arguments.get("tabId")
    request = arguments.get("request_id")
    browser = arguments.get("browser_id", "dedicated")
    if (not isinstance(tab, int) or isinstance(tab, bool) or tab < 1
            or not isinstance(request, str) or not request or len(request) > 200
            or not isinstance(browser, str) or not browser or len(browser) > 64):
        raise HostError("invalid_provider_control", "exact browser, tab and pending request are required")
    origin = arguments.get("origin")
    permissions = arguments.get("permissions", [])
    if tool == "browser_control":
        if origin is not None or not isinstance(permissions, list) or permissions:
            raise HostError("invalid_provider_control", "resume cannot change origin permissions")
    else:
        if not isinstance(origin, str):
            raise HostError("invalid_provider_control", "permission decisions require the exact canonical origin")
        try:
            parsed = urlsplit(origin)
        except ValueError as exc:
            raise HostError("invalid_provider_control", "permission origin is invalid") from exc
        if parsed.scheme not in {"https", "http"} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise HostError("invalid_provider_control", "permission origin must be an HTTP(S) origin without credentials/path")
        if (not isinstance(permissions, list) or not permissions or len(permissions) > 6
                or any(not isinstance(item, str) or item not in _PERMISSION_NAMES for item in permissions)
                or len(set(permissions)) != len(permissions)):
            raise HostError("invalid_provider_control", "permission decisions require distinct supported permissions")
    payload = {"version": 1, "action": action, "browser_id": browser, "tab_id": tab,
               "request_id": request, "nonce": secrets.token_hex(24),
               "expires_at_ms": int(time.time() * 1000) + 30_000,
               "origin": origin, "permissions": sorted(permissions)}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
    return {"openagent/browser-approval": {"payload": payload, "signature": signature}}


async def call_provider_control(adapter: MCPStdioServer, tool: str, arguments: dict[str, Any], *, secret: str) -> ToolResult:
    metadata = _operator_metadata(tool, arguments, secret)
    return await adapter.call(tool, arguments, metadata=metadata)
