"""REST projection of the standalone catalog management service."""
from aiohttp import web


async def _call(request, operation, *, write=False):
    runtime = getattr(request.app['gateway'], 'runtime_service', None)
    if runtime is None:
        raise web.HTTPServiceUnavailable(text='Runtime catalog is not ready')
    try:
        context = await runtime.context(request, '__catalog_management__')
        service = runtime.catalog_management
        result = await operation(service, context)
        if write:
            await request.app['gateway'].broadcast_resource('mcp', 'updated', request.match_info.get('name'))
        return result
    except PermissionError:
        raise web.HTTPForbidden(text='Catalog operation not authorized') from None
    except LookupError:
        raise web.HTTPNotFound() from None
    except (ValueError, TypeError):
        raise web.HTTPBadRequest(text='Invalid catalog request') from None


async def handle_list(request):
    rows = await _call(request, lambda service, context: service.list(context))
    return web.json_response({'mcps': rows})


async def handle_get(request):
    row = await _call(request, lambda service, context: service.get(context, request.match_info['name']))
    return web.json_response({'mcp': row})


async def handle_create(request):
    body = await request.json() if request.can_read_body else {}
    if not isinstance(body, dict):
        raise web.HTTPBadRequest()
    values = dict(body)
    name = values.pop('name', '')
    row = await _call(request, lambda service, context: service.create(context, name, **values), write=True)
    return web.json_response({'ok': True, 'mcp': row}, status=201)


async def handle_update(request):
    body = await request.json() if request.can_read_body else {}
    if not isinstance(body,dict):
        raise web.HTTPBadRequest()
    row = await _call(request, lambda service, context: service.update(context, request.match_info['name'], **body), write=True)
    return web.json_response({'ok': True, 'mcp': row})


async def handle_delete(request):
    await _call(request, lambda service, context: service.delete(context, request.match_info['name']), write=True)
    return web.json_response({'ok': True})


async def _set_enabled(request, enabled):
    row = await _call(request, lambda service, context: service.set_enabled(context, request.match_info['name'], enabled), write=True)
    return web.json_response({'ok': True, 'mcp': row})


async def handle_enable(request):
    return await _set_enabled(request, True)


async def handle_disable(request):
    return await _set_enabled(request, False)
