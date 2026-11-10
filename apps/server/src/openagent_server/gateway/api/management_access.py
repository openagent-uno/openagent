"""Read page visibility and change access or ownership of the selected agent."""

from aiohttp import web


async def _call(request, operation, field=None):
    runtime = getattr(request.app["gateway"], "runtime_service", None)
    if runtime is None:
        raise web.HTTPServiceUnavailable(text="Agent access settings are not ready")
    try:
        context = await runtime.context(request, "__agent_access__")
        args = []
        if field:
            body = await request.json()
            if not isinstance(body, dict) or set(body) != {field}:
                raise ValueError(f"Provide only {field}")
            args.append(body[field])
        if "handle" in request.match_info:
            args.append(request.match_info["handle"].strip().lower())
        data = await getattr(runtime.management_access, operation)(context, *args)
    except PermissionError as exc:
        raise web.HTTPForbidden(text=str(exc)) from None
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc)) from None
    except LookupError as exc:
        raise web.HTTPNotFound(text=str(exc)) from None
    return web.json_response(data, headers={"Cache-Control": "no-store"})


async def handle_get(request):
    return await _call(request, "settings")


async def handle_patch(request):
    return await _call(request, "update", "visibility")


async def handle_owner(request):
    return await _call(request, "transfer", "owner_handle")
