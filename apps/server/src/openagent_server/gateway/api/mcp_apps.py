"""Authenticated optional MCP Apps; execution identity is resolved for every request."""
from dataclasses import replace
from contextlib import contextmanager
from openagent_core.core.execution_origin import execution_origin_scope
from openagent_core.core.on_behalf_context import OnBehalfIdentity, install_on_behalf_identity, reset_on_behalf_identity
from aiohttp import web
from openagent_core.mcp_apps import McpAppService, saved_invocation_display
from openagent_core.runtime import execution_scope


@contextmanager
def _current_client(request, gateway):
    """A client selector never grants authority beyond this verified certificate."""
    values = request.headers.getall("X-OpenAgent-Client-Instance", [])
    identity, origin = None, None
    if request.get("device_cert") is not None and request.get("auth_kind") in {"device_cert", "agent"}:
        identity = OnBehalfIdentity.from_certificate(request.get("device_cert"), auth_kind=request.get("auth_kind"))
    if values:
        if len(values) != 1 or request.get("auth_kind") != "device_cert":
            raise PermissionError("Client resources require an exact verified device")
        instance = values[0]
        if not instance or len(instance) > 128 or any(ord(c) < 33 or ord(c) == 127 for c in instance):
            raise PermissionError("Invalid client instance")
        identity = OnBehalfIdentity.from_certificate(request.get("device_cert"))
        registry = getattr(gateway, "capabilities", None)
        origin = registry.origin_for(identity.device_id, instance) if registry else None
        if origin is not None and (origin.device_id != identity.device_id
                or origin.auth_epoch != request.get("device_auth_epoch", 0)):
            origin = None
        # A disabled/missing current client grants no interactive lease. Pool
        # MCP Apps remain usable; exact client ToolRefs still fail closed.
    token = install_on_behalf_identity(identity)
    try:
        with execution_origin_scope(origin):
            yield
    finally:
        reset_on_behalf_identity(token)

async def handle(request):
    service = getattr(request.app["gateway"], "runtime_service", None)
    if service is None or service.runtime is None:
        raise web.HTTPServiceUnavailable(text="Runtime unavailable")
    try:
        body = await request.json()
        if not isinstance(body, dict): raise ValueError("Object required")
        session_id = request.match_info["session_id"]
        if not session_id or len(session_id) > 512 or any(ord(c) < 32 for c in session_id):
            raise ValueError("Invalid session")
        with _current_client(request, request.app["gateway"]):
            context = await service.context(request, session_id)
            context = replace(context, capabilities=tuple(await service.capability_context_resolver(context)))
            apps = getattr(service, "mcp_apps", None)
            if apps is None:
                apps = service.mcp_apps = McpAppService(service.runtime.capabilities)
                service.runtime.services.registry.bind("mcp_apps", apps)
            operation = request.match_info["operation"].strip("/").split("/")
            with execution_scope(service.runtime, context, None):
                if operation == ["open"] and set(body) <= {"tool_ref", "tool_call_id"}:
                    # Presentation comes from the exact declared source. Caller hints
                    # never provide executable HTML, metadata or runtime authority.
                    display_reader = None
                    if body.get("tool_call_id") is not None:
                        selector, tool_ref = body["tool_call_id"], body["tool_ref"]
                        async def display_reader(current):
                            return await saved_invocation_display(service.runtime.services.store, service.authorizer, current, selector, tool_ref)
                    result = await apps.open(body["tool_ref"], context, display_reader=display_reader)
                elif len(operation) == 2 and operation[1] == "request" and set(body) <= {"method", "params", "request_id"}:
                    result = await apps.request(operation[0], body["method"], body.get("params", {}), context, request_id=body.get("request_id"))
                elif len(operation) == 2 and operation[1] == "cancel" and set(body) == {"request_id"}:
                    result = {"cancelled": await apps.cancel(operation[0], body["request_id"], context)}
                elif len(operation) == 2 and operation[1] == "close" and not body:
                    result = {"closed": await apps.close(operation[0], context)}
                else: raise ValueError("Unsupported app operation")
        return web.json_response(result, headers={"Cache-Control": "no-store"})
    except (KeyError, TypeError, ValueError):
        raise web.HTTPBadRequest(text="Invalid app request") from None
    except PermissionError:
        raise web.HTTPForbidden(text="App interaction no longer authorized") from None
    except (RuntimeError, LookupError):
        raise web.HTTPConflict(text="App interaction unavailable") from None
