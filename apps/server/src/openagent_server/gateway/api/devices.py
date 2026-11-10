"""Authenticated device inventory and direct, deterministic computer interaction."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import os
import re
from aiohttp import web
from openagent_core.contracts import ResourceRef
from openagent_core.capabilities import CapabilityUnavailable
from openagent_core.core.on_behalf_context import install_on_behalf_identity, reset_on_behalf_identity
from openagent_core.runtime import execution_scope
from openagent_server.agent_desktop import HOST_SCOPE, agent_desktop_for
from openagent_server.device_directory import directory_for
from .sessions import _authorized_session

HEADERS = {'Cache-Control': 'no-store'}


async def _identity(request):
    gateway = request.app['gateway']
    service = getattr(gateway, 'runtime_service', None)
    if service is None or service.runtime is None:
        raise web.HTTPServiceUnavailable(text='Runtime unavailable')
    identity = await service.authorizer.bind_request(request)
    if identity.auth_kind != 'device_cert' or identity.principal_type != 'user':
        raise PermissionError('A human device certificate is required')
    return identity


@asynccontextmanager
async def _session(request, *, execute=False):
    gateway = request.app['gateway']
    service = gateway.runtime_service
    identity = await _identity(request)
    session_id = request.match_info['session_id']
    _, _, _, problem = await _authorized_session(request, gateway.agent.memory_db, session_id,
                                                 permission='view')
    if problem is not None:
        raise web.HTTPNotFound(text='Session unavailable')
    token = install_on_behalf_identity(identity)
    try:
        context = await service.authorizer.context_for_identity(identity, session_id)
        context = replace(context, capabilities=tuple(await service.capability_context_resolver(context)))
        if not await service.authorizer.authorize(context, 'run.execute' if execute else 'run.read',
                ResourceRef('session', context.tenant_id, session_id), audience=context.audience):
            raise PermissionError('Session access revoked')
        with execution_scope(service.runtime, context, None):
            yield gateway, identity, context
    finally:
        reset_on_behalf_identity(token)


async def handle_devices(request):
    try:
        identity = await _identity(request)
        gateway = request.app['gateway']
        result = await directory_for(gateway).devices(identity, gateway.capabilities)
        return web.json_response({'devices': result}, headers=HEADERS)
    except PermissionError:
        raise web.HTTPForbidden(text='Device inventory unavailable') from None


async def _desktop_access(gateway, context):
    service = gateway.runtime_service
    if not await service.management_access.verified_member(context):
        raise PermissionError("A verified active member is required")
    handle = context.initiator.subject_id
    if handle == await service.directory.owner_handle():
        return "control"
    environment = getattr(gateway.agent, "product_environment", os.environ)
    viewers = {value.strip() for value in environment.get("OPENAGENT_DESKTOP_VIEWERS", "").split(",")}
    return "view" if handle in viewers else "none"


async def _desktop_context(request):
    gateway = request.app["gateway"]
    identity = await _identity(request)
    return await gateway.runtime_service.authorizer.context_for_identity(identity, HOST_SCOPE)


async def handle_session_devices(request):
    try:
        async with _session(request) as (gateway, identity, context):
            result = await directory_for(gateway).session_devices(identity.tenant_id, context.session_id, gateway.capabilities)
            return web.json_response({'devices': result}, headers=HEADERS)
    except PermissionError:
        raise web.HTTPForbidden(text='Session unavailable') from None


async def handle_participants(request):
    try:
        async with _session(request) as (gateway, identity, context):
            from openagent_core.workspace_administration import SessionInspection
            result = await SessionInspection(gateway.agent.memory_db,
                gateway.runtime_service.authorizer).participants(context, context.session_id)
            return web.json_response(result, headers=HEADERS)
    except (PermissionError, LookupError):
        raise web.HTTPNotFound(text='Session unavailable') from None


def computer_tools(tools):
    # A browser tab also exposes a tool named ``computer``. It requires a
    # tab identifier and cannot accept this desktop view's input contract.
    # The server-local tool is also excluded to keep host desktop policy
    # separate. Client source IDs are scoped to the exact client lease.
    return [tool for tool in tools if tool.source_id != "computer-control"
            and tool.name in {'computer', 'computer_control_computer'}
            and 'action' in tool.input_schema.get('properties', {})
            and set(tool.input_schema.get('required', ())) <= {'action', 'coordinate', 'text'}
            and ('enum' not in tool.input_schema['properties']['action']
                 or {'get_screenshot', 'mouse_move', 'left_click', 'key', 'type'}
                 <= set(tool.input_schema['properties']['action']['enum']))]


async def handle_targets(request):
    try:
        if "session_id" not in request.match_info:
            gateway = request.app["gateway"]
            context = await _desktop_context(request)
            access = await _desktop_access(gateway, context)
            return web.json_response(await agent_desktop_for(gateway).inventory(access), headers=HEADERS)
        async with _session(request) as (gateway, _, context):
            tools = computer_tools(await gateway.runtime_service.runtime.capabilities.discover(context))
            return web.json_response({"targets": [
                dict(tool_ref=t.tool_ref, label=t.target_label, live_media=t.metadata.get("openagent/liveMedia"))
                for t in tools
            ]}, headers=HEADERS)
    except PermissionError:
        raise web.HTTPForbidden(text="Computer access unavailable") from None


def computer_arguments(body):
    if not isinstance(body, dict) or set(body) - {'tool_ref', 'action', 'coordinate', 'text'}:
        raise ValueError('Invalid computer request')
    if not isinstance(body.get('tool_ref'), str) or not 1 <= len(body['tool_ref']) <= 512:
        raise ValueError('Exact computer reference required')
    action = body.get('action')
    if action not in {'get_screenshot', 'mouse_move', 'middle_click', 'left_click', 'double_click', 'right_click', 'left_click_drag', 'scroll', 'key', 'type'}:
        raise ValueError('Unsupported computer action')
    args = {'action': action}
    if action in {'mouse_move', 'middle_click', 'left_click', 'double_click', 'right_click', 'left_click_drag', 'scroll'}:
        xy = body.get('coordinate')
        if (not isinstance(xy, list) or len(xy) != 2
                or any(type(v) is not int or not 0 <= v <= 32768 for v in xy)):
            raise ValueError('Screen coordinate required')
        args['coordinate'] = xy
    if action in {'key', 'type', 'scroll'}:
        value = body.get('text')
        if not isinstance(value, str) or not value or len(value) > 16384:
            raise ValueError('Text required')
        if action == 'scroll' and re.fullmatch(r'(?:up|down|left|right)(?::(?:[1-9][0-9]{0,2}|[12][0-9]{3}|3000))?', value) is None:
            raise ValueError('Invalid scroll direction')
        args['text'] = value
    return args


async def handle_computer(request):
    try:
        body = await request.json()
        direct = "session_id" not in request.match_info
        screen_size = body.pop("screen_size", None) if direct and isinstance(body, dict) else None
        args = computer_arguments(body)
        if screen_size is not None and (not isinstance(screen_size, list) or len(screen_size) != 2
                or any(type(value) is not int or not 1 <= value <= 32768 for value in screen_size)):
            raise ValueError("Invalid display size")
        reference = body["tool_ref"]
        if direct:
            gateway = request.app["gateway"]
            context = await _desktop_context(request)
            access = await _desktop_access(gateway, context)
            snapshot = args["action"] == "get_screenshot"
            if access == "none" or (not snapshot and access != "control"):
                raise PermissionError("This login cannot perform the desktop action")
            result = await agent_desktop_for(gateway).interact(reference, args, screen_size)
            if snapshot and await _desktop_access(gateway, context) == "none":
                raise PermissionError("Desktop access revoked")
        else:
            async with _session(request, execute=True) as (gateway, _, context):
                catalog = gateway.runtime_service.runtime.capabilities
                targets = computer_tools(await catalog.discover(context))
                if reference not in {t.tool_ref for t in targets}:
                    raise CapabilityUnavailable("The exact computer is offline or no longer authorized")
                result = await catalog.call_tool(reference, args, context, surface="app")
                if hasattr(result, "model_dump"):
                    result = result.model_dump(mode="json", by_alias=True)
        return web.json_response(result, headers=HEADERS)
    except (ValueError, TypeError, KeyError):
        raise web.HTTPBadRequest(text="Invalid computer request") from None
    except PermissionError:
        raise web.HTTPForbidden(text="Computer access unavailable") from None
    except (CapabilityUnavailable, RuntimeError, LookupError, OSError, TimeoutError):
        raise web.HTTPConflict(text="The exact computer is unavailable; reconnect and reopen its view") from None


@asynccontextmanager
async def _stream_source(request):
    if "session_id" not in request.match_info:
        gateway = request.app["gateway"]
        context = await _desktop_context(request)

        async def authorize():
            if await _desktop_access(gateway, context) == "none":
                raise PermissionError("Desktop access revoked")

        await authorize()
        yield agent_desktop_for(gateway).stream, authorize
        return
    async with _session(request, execute=True) as (gateway, _, context):
        catalog = gateway.runtime_service.runtime.capabilities

        async def stream(reference, options):
            if reference not in {t.tool_ref for t in computer_tools(await catalog.discover(context))}:
                raise CapabilityUnavailable("Exact computer unavailable")
            iterator = catalog.stream_tool(reference, options, context)
            try:
                async for packet in iterator:
                    yield packet
            finally:
                await iterator.aclose()

        yield stream, None


async def handle_stream(request):
    """Ephemeral encoded video over the same authenticated session transport."""
    ws = web.WebSocketResponse(max_msg_size=8192, heartbeat=15)
    reader = None
    frame = None
    try:
        async with _stream_source(request) as (stream, authorize):
            await ws.prepare(request)
            hello = await ws.receive_json(timeout=10)
            if not isinstance(hello, dict) or set(hello) - {'tool_ref', 'options'}:
                raise ValueError('Invalid stream request')
            tool_ref = hello.get('tool_ref')
            if not isinstance(tool_ref, str) or not 1 <= len(tool_ref) <= 512:
                raise ValueError("Exact computer reference required")
            async def watch_close():
                async for _ in ws:
                    pass
            reader = asyncio.create_task(watch_close())
            from openagent_device_tools.media import stream_options
            iterator = stream(tool_ref, stream_options(hello.get("options", {})))
            try:
                next_access_check = 0.0
                while not ws.closed:
                    frame = asyncio.create_task(anext(iterator))
                    done, _ = await asyncio.wait((reader, frame), return_when=asyncio.FIRST_COMPLETED)
                    if reader in done:
                        frame.cancel()
                        await asyncio.gather(frame, return_exceptions=True)
                        break
                    try:
                        packet = frame.result()
                    except StopAsyncIteration:
                        break
                    if authorize and asyncio.get_running_loop().time() >= next_access_check:
                        await authorize()
                        next_access_check = asyncio.get_running_loop().time() + 1
                    await ws.send_json(packet)
            finally:
                if frame is not None and not frame.done():
                    frame.cancel()
                    await asyncio.gather(frame, return_exceptions=True)
                await iterator.aclose()
    except (PermissionError, CapabilityUnavailable, RuntimeError, LookupError, ValueError, OSError, asyncio.TimeoutError):
        if ws.prepared and not ws.closed:
            try:
                await ws.send_json({'type':'error', 'message':'Desktop stream unavailable or no longer authorized. Check the host’s screen recording permission.'})
            except ConnectionResetError:
                pass
        elif not ws.prepared:
            raise web.HTTPForbidden(text='Desktop unavailable') from None
    finally:
        if reader is not None:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        if ws.prepared:
            await ws.close()
    return ws
