"""Native HTTP adapter over the shared authorized vault service."""
from pathlib import Path
from aiohttp import web
from openagent_core.administration import ManagementContext
from openagent_core.contracts import PrincipalRef
from openagent_core.vault_administration import VaultAdministration
from openagent_server.provider_management import NativeAdminAuthorizer


class NativeVaultAuthorizer(NativeAdminAuthorizer):
    async def authorize(self, context, action, resource, *, audience=()):
        if action not in {"vault.read", "vault.write"}:
            return False
        policies = self.service.agent.config.get("runtime_tool_audiences") or {}
        check = "model.read" if action == "vault.read" and policies.get("vault") == "installation" else "vault.owner"
        return await super().authorize(context, check, resource, audience=audience)


async def for_request(request):
    gateway = request.app["gateway"]
    service = getattr(gateway, "runtime_service", None)
    if service is None or service.runtime is None or not gateway.vault_path:
        raise web.HTTPServiceUnavailable(text="Vault administration is not ready")
    try:
        identity = await service.authorizer.bind_request(request)
    except PermissionError:
        raise web.HTTPForbidden(text="Verified certificate required") from None
    principal = PrincipalRef("openagent", identity.tenant_id, identity.handle, identity.principal_type)
    context = ManagementContext(principal, service.agent.name)
    environment = dict(service.runtime.settings.environment)
    validate = environment.get("OPENAGENT_VAULT_VALIDATE_ON_WRITE", "true").strip().lower() in {"1", "true", "yes", "on"}
    admin = VaultAdministration(Path(gateway.vault_path).expanduser(),
        NativeVaultAuthorizer(service, request, principal), runtime=service.runtime,
        validate_on_write=validate)
    return admin, context


async def broadcast_change(gateway, action, note_path=None):
    """Paths and even private-corpus activity go only to current readers."""
    payload = {"type": "resource_event", "resource": "vault", "action": action}
    if note_path is not None:
        payload["id"] = note_path
    requests = getattr(gateway, "_chat_client_requests", {})
    for connection_id, socket in tuple(gateway.clients.items()):
        request = requests.get(connection_id)
        if request is None or socket.closed:
            continue
        try:
            admin, context = await for_request(request)
            await admin.authorize(context, "vault.read")
            if gateway.clients.get(connection_id) is socket:
                await gateway._safe_ws_send_json(socket, payload)
        except (PermissionError, web.HTTPException):
            continue


async def _handle(request, operation):
    try:
        admin, context = await for_request(request)
        body = await request.json() if operation in {"write", "restore", "reset", "move"} else {}
        result = await admin.execute(context, operation,
            path=request.match_info.get("path"), query=dict(request.query), body=body)
    except PermissionError:
        return web.json_response({"error": "Vault access is not authorized"}, status=403)
    except (ValueError, TypeError):
        return web.json_response({"error": "Invalid vault request"}, status=400)
    except LookupError:
        return web.json_response({"error": "Not found"}, status=404)
    # The service owns all writes, validation, versioning and provenance.
    # A downstream error is never converted into a raw filesystem write.
    if operation == "write":
        if not result.get("ok", True):
            return web.json_response({"ok": False, "path": result["path"], "blocked": True,
                "errors": result.get("errors", []), "warnings": result.get("warnings", [])}, status=422)
        await broadcast_change(request.app["gateway"], "updated" if result.get("existed") else "created", result["path"])
        result = {key: result.get(key) for key in ("ok", "path", "warnings", "applied", "commit")}
    elif operation == "delete":
        await broadcast_change(request.app["gateway"], "deleted", request.match_info.get("path"))
    elif operation in {"restore", "reset", "move", "derived", "init", "doctor"}:
        if "error" in result:
            return web.json_response(result, status=409)
        if operation != "doctor" or request.query.get("apply", "false").lower() in {"1", "true", "yes", "on"}:
            await broadcast_change(request.app["gateway"], "changed")
    return web.json_response(result)


def _route(operation):
    async def handle(request):
        return await _handle(request, operation)
    return handle


handle_list = _route("notes")
handle_read = _route("read")
handle_write = _route("write")
handle_delete = _route("delete")
handle_graph = _route("graph")
handle_search = _route("search")
handle_search_files = _route("search/files")
handle_search_in_file = _route("search/in-file")
handle_gate = _route("gate")
handle_stats = _route("stats")
handle_history = _route("history")
handle_commit = _route("commit")
handle_restore = _route("restore")
handle_reset = _route("reset")
handle_doctor = _route("doctor")
handle_derived = _route("derived")
handle_move = _route("move")
handle_init = _route("init")
handle_index_sync = _route("index/sync")
