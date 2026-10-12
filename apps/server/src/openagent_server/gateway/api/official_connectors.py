"""Authenticated management; credentials are never included in API responses."""
from aiohttp import web


async def _call(request, method, *, body=False):
    runtime = getattr(request.app["gateway"], "runtime_service", None)
    if runtime is None:
        raise web.HTTPServiceUnavailable()
    context = await runtime.context(request, "__catalog_management__")
    service = runtime.official_connectors
    arguments = [context]
    if "connection_id" in request.match_info:
        arguments.append(request.match_info["connection_id"])
    if body:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise web.HTTPBadRequest()
        arguments.append(payload)
    try:
        result = await getattr(service, method)(*arguments)
    except PermissionError:
        raise web.HTTPForbidden(text="Connector operation not authorized") from None
    except (ValueError, TypeError, StopIteration):
        raise web.HTTPBadRequest(text="Invalid connector request") from None
    except RuntimeError:
        raise web.HTTPServiceUnavailable(text="Connector authorization is temporarily unavailable") from None
    response = web.json_response(result or {"ok": True})
    response.headers["Cache-Control"] = "no-store"
    return response


async def catalog(request): return await _call(request, "catalog")
async def connections(request): return await _call(request, "list")
async def create(request): return await _call(request, "create", body=True)
async def connect(request): return await _call(request, "connect")
async def poll(request): return await _call(request, "poll")
async def update(request): return await _call(request, "update", body=True)
async def disconnect(request): return await _call(request, "disconnect")
