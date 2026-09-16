"""Certificate-authorized standalone adapter for public model administration."""

from aiohttp import web
from openagent_core.administration import ManagementContext, ProviderModelAdmin
from openagent_core.contracts import PrincipalRef


class NativeAdminAuthorizer:
    def __init__(self, service, request, principal):
        self.service, self.request, self.principal = service, request, principal

    async def authorize(self, context, action, resource, *, audience=()):
        if (
            context.authority != self.principal
            or resource.tenant_id != self.principal.tenant_id
            or resource.resource_id != self.service.agent.name
        ):
            return False
        certificate = self.request.get("device_cert")
        if (
            certificate is None
            or not await self.service.gateway._request_device_still_authorized(
                self.request, certificate
            )
        ):
            return False
        if not await self.service.directory.principal_active(self.principal):
            return False
        if action == "model.read":
            return True
        return (
            self.principal.kind == "user"
            and self.principal.subject_id == await self.service.directory.owner_handle()
        )


async def for_request(request):
    service = getattr(request.app["gateway"], "runtime_service", None)
    if service is None:
        raise web.HTTPServiceUnavailable(text="Model administration is not ready")
    try:
        identity = await service.authorizer.bind_request(request)
    except PermissionError:
        raise web.HTTPForbidden(text="Verified certificate required") from None
    principal = PrincipalRef(
        "openagent", identity.tenant_id, identity.handle, identity.principal_type
    )
    context = ManagementContext(principal, service.agent.name)
    admin = ProviderModelAdmin(
        service.agent.memory_db,
        NativeAdminAuthorizer(service, request, principal),
        reload_catalog=service.agent.load_model_catalog,
        runtime=service.runtime,
    )
    return admin, context


async def authorize_request(request):
    admin, context = await for_request(request)
    domain = "provider" if request.path.startswith("/api/providers") else "model"
    action = domain + (".read" if request.method == "GET" else ".write")
    try:
        await admin.authorize(context, action)
    except PermissionError:
        raise web.HTTPForbidden(text="Model administration is not authorized") from None
