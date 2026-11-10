"""Member presentation and owner management of the agent's persona."""

from __future__ import annotations

from typing import Any

from openagent_product_config.agent_identity import (
    AgentIdentityConflict,
    AgentIdentityInputError,
    AgentIdentityPermissionError,
    AgentIdentityService,
)
from openagent_core.core.on_behalf_context import OnBehalfIdentity


def service_for_request(request: Any) -> AgentIdentityService:
    gateway = request.app["gateway"]
    return AgentIdentityService(
        agent=gateway.agent,
        db=getattr(gateway.agent, "_db", None),
        config_path=gateway.config_path,
        gateway=gateway,
    )


def actor_for_request(request: Any) -> OnBehalfIdentity:
    return OnBehalfIdentity.from_certificate(
        request.get("device_cert"),
        auth_kind=str(request.get("auth_kind") or ""),
    )


def error_response(exc: Exception):
    from aiohttp import web

    if isinstance(exc, AgentIdentityPermissionError) or isinstance(exc, PermissionError):
        return web.json_response({"error": str(exc)}, status=403)
    if isinstance(exc, AgentIdentityConflict):
        return web.json_response({"error": str(exc)}, status=409)
    if isinstance(exc, AgentIdentityInputError):
        return web.json_response({"error": str(exc)}, status=400)
    raise exc


async def handle_get(request):
    from aiohttp import web

    service = service_for_request(request)
    try:
        try:
            data = await service.get(actor_for_request(request))
        except AgentIdentityPermissionError:
            runtime = getattr(request.app["gateway"], "runtime_service", None)
            if runtime is None:
                raise
            context = await runtime.context(request, "__agent_identity__")
            if not await runtime.management_access.can_browse(context):
                raise
            data = {**await service.presentation(), "can_manage": False,
                    "framework_prompt_mutable": False}
        return web.json_response(data)
    except Exception as exc:  # noqa: BLE001
        return error_response(exc)


async def handle_patch(request):
    from aiohttp import web

    try:
        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise AgentIdentityInputError(
                "request body must contain valid JSON",
            ) from exc
        if not isinstance(body, dict):
            raise AgentIdentityInputError("request body must be an object")
        allowed = {"name", "system_prompt", "thumbnail", "expected_revision"}
        unknown = sorted(set(body) - allowed)
        if unknown:
            raise AgentIdentityInputError(
                f"unknown identity fields: {', '.join(unknown)}",
            )
        return web.json_response(await service_for_request(request).update(
            actor_for_request(request),
            name=body.get("name"),
            system_prompt=body.get("system_prompt"),
            expected_revision=body.get("expected_revision"),
            **({"thumbnail": body["thumbnail"]} if "thumbnail" in body else {}),
        ))
    except Exception as exc:  # noqa: BLE001
        return error_response(exc)


__all__ = [
    "actor_for_request",
    "error_response",
    "handle_get",
    "handle_patch",
    "service_for_request",
]
