"""Authenticated management; credentials are never included in API responses."""
from aiohttp import web


async def _call(request, method, *, body=False, browse=False):
    runtime = getattr(request.app["gateway"], "runtime_service", None)
    if runtime is None:
        raise web.HTTPServiceUnavailable()
    service = runtime.official_connectors
    arguments = []
    if "connection_id" in request.match_info:
        arguments.append(request.match_info["connection_id"])
    if "request_id" in request.match_info:
        arguments.append(request.match_info["request_id"])
    if body:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise web.HTTPBadRequest()
        arguments.append(payload)
    try:
        context = await runtime.context(request, "__catalog_management__")
        result = await getattr(service, method)(context, *arguments, **({"browse": True} if browse else {}))
    except PermissionError:
        raise web.HTTPForbidden(text="Connector operation not authorized") from None
    except (ValueError, TypeError, StopIteration):
        raise web.HTTPBadRequest(text="Invalid connector request") from None
    except RuntimeError:
        raise web.HTTPServiceUnavailable(text="Connector authorization is temporarily unavailable") from None
    response = web.json_response(result or {"ok": True})
    response.headers["Cache-Control"] = "no-store"
    return response


async def catalog(request): return await _call(request, "catalog", browse=True)
async def connections(request): return await _call(request, "list", browse=True)
async def create(request): return await _call(request, "create", body=True)
async def connect(request): return await _call(request, "connect")
async def poll(request): return await _call(request, "poll")
async def refresh(request): return await _call(request, "refresh")
async def sites(request): return await _call(request, "sites")
async def select_site(request): return await _call(request, "select_site", body=True)
async def microsoft_resources(request): return await _call(request, "microsoft_resources", body=True)
async def select_microsoft_site(request): return await _call(request, "select_microsoft_site", body=True)
async def select_microsoft_drive(request): return await _call(request, "select_microsoft_drive", body=True)
async def update(request): return await _call(request, "update", body=True)
async def disconnect(request): return await _call(request, "disconnect")
async def privacy_export(request): return await _call(request, "privacy_export")
async def privacy_export_ack(request): return await _call(request, "privacy_export_ack", body=True)
