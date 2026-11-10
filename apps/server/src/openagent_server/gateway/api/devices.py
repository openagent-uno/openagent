"""Authenticated device inventory and direct, deterministic computer interaction."""
from contextlib import asynccontextmanager
from dataclasses import replace
import re
from aiohttp import web
from openagent_core.contracts import ResourceRef
from openagent_core.capabilities import CapabilityUnavailable
from openagent_core.core.on_behalf_context import install_on_behalf_identity, reset_on_behalf_identity
from openagent_core.runtime import execution_scope
from openagent_server.device_directory import AGENT_COMPUTER_CONTEXT, AGENT_COMPUTER_SOURCE, directory_for
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


async def _check_agent_computer(gateway, context):
    service = gateway.runtime_service
    if (not await service.management_access.verified_member(context)
            or context.initiator.subject_id != await service.directory.owner_handle()):
        raise PermissionError('Only the agent owner may control its desktop')


@asynccontextmanager
async def _computer_scope(request, *, execute=False):
    if 'session_id' in request.match_info:
        async with _session(request, execute=execute) as (gateway, _, context):
            yield gateway, context, False
        return
    gateway = request.app['gateway']
    service = gateway.runtime_service
    identity = await _identity(request)
    token = install_on_behalf_identity(identity)
    try:
        context = await service.authorizer.context_for_identity(identity, AGENT_COMPUTER_CONTEXT)
        await _check_agent_computer(gateway, context)
        # A direct desktop interaction has no conversation or personal-device leases.
        with execution_scope(service.runtime, context, None):
            yield gateway, context, True
    finally:
        reset_on_behalf_identity(token)


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


def computer_tools(tools, *, agent_only=False):
    # A browser tab also exposes a tool named ``computer``. It requires a
    # tab identifier and cannot accept this desktop view's input contract.
    # Match the callable schema, never labels or opaque reference prefixes.
    return [tool for tool in tools if (not agent_only or tool.source_id == AGENT_COMPUTER_SOURCE)
            and tool.name in {'computer', 'computer_control_computer'}
            and 'action' in tool.input_schema.get('properties', {})
            and set(tool.input_schema.get('required', ())) <= {'action', 'coordinate', 'text'}
            and ('enum' not in tool.input_schema['properties']['action']
                 or {'get_screenshot', 'mouse_move', 'left_click', 'key', 'type'}
                 <= set(tool.input_schema['properties']['action']['enum']))]


async def handle_targets(request):
    try:
        async with _computer_scope(request) as (gateway, context, agent_only):
            tools = computer_tools(await gateway.runtime_service.runtime.capabilities.discover(context), agent_only=agent_only)
            return web.json_response({'targets': [dict(tool_ref=t.tool_ref, label=t.target_label, live_media=t.metadata.get('openagent/liveMedia'), agent_host=t.source_id == AGENT_COMPUTER_SOURCE) for t in tools]}, headers=HEADERS)
    except PermissionError:
        raise web.HTTPForbidden(text='Computer access unavailable') from None


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
        args = computer_arguments(body)
        async with _computer_scope(request, execute=True) as (gateway, context, agent_only):
            catalog = gateway.runtime_service.runtime.capabilities
            targets = computer_tools(await catalog.discover(context), agent_only=agent_only)
            if body['tool_ref'] not in {t.tool_ref for t in targets}:
                raise CapabilityUnavailable('The exact computer is offline or no longer authorized')
            result = await catalog.call_tool(body['tool_ref'], args, context, surface='app')
            if hasattr(result, 'model_dump'):
                result = result.model_dump(mode='json', by_alias=True)
            return web.json_response(result, headers=HEADERS)
    except (ValueError, TypeError, KeyError):
        raise web.HTTPBadRequest(text='Invalid computer request') from None
    except PermissionError:
        raise web.HTTPForbidden(text='Computer access revoked') from None
    except (CapabilityUnavailable, RuntimeError, LookupError):
        raise web.HTTPConflict(text='The exact computer is unavailable; reconnect and reopen its view') from None


async def handle_stream(request):
    """Ephemeral encoded video over the same authenticated session transport."""
    import asyncio
    ws = web.WebSocketResponse(max_msg_size=8192, heartbeat=15)
    reader = None
    frame = None
    try:
        async with _computer_scope(request, execute=True) as (gateway, context, agent_only):
            await ws.prepare(request)
            hello = await ws.receive_json(timeout=10)
            if not isinstance(hello, dict) or set(hello) - {'tool_ref', 'options'}:
                raise ValueError('Invalid stream request')
            tool_ref = hello.get('tool_ref')
            catalog = gateway.runtime_service.runtime.capabilities
            targets = computer_tools(await catalog.discover(context), agent_only=agent_only)
            if not isinstance(tool_ref, str) or tool_ref not in {tool.tool_ref for tool in targets}:
                raise CapabilityUnavailable('Exact computer unavailable')
            async def watch_close():
                async for _ in ws:
                    pass
            reader = asyncio.create_task(watch_close())
            from openagent_device_tools.media import stream_options
            iterator = catalog.stream_tool(tool_ref, stream_options(hello.get('options', {})), context)
            try:
                next_owner_check = 0.0
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
                    if agent_only and asyncio.get_running_loop().time() >= next_owner_check:
                        await _check_agent_computer(gateway, context)
                        next_owner_check = asyncio.get_running_loop().time() + 1
                    await ws.send_json(packet)
            finally:
                if frame is not None and not frame.done():
                    frame.cancel()
                    await asyncio.gather(frame, return_exceptions=True)
                await iterator.aclose()
    except (PermissionError, CapabilityUnavailable, RuntimeError, LookupError, ValueError, asyncio.TimeoutError):
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
