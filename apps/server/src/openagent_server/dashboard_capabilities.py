"""App-owned dashboard source bound to one verified chat connection.

Dashboard persistence may live in the server, but only an originating App
registration exposes its tools. Local-computer consent is independent.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from openagent_core.capabilities import CapabilityUnavailable, ToolDefinition
from openagent_core.contracts import CapabilityLease, PrincipalRef, ResourceRef
from openagent_core.core.execution_origin import current_ingress_identity
from openagent_core.core.execution_origin import TrustedIngressIdentity, TrustedTurnContext
from openagent_identity.runtime_access import AccessContext
from openagent_core.runtime import current_execution_context
from openagent_dashboards.service import service_for_gateway
from openagent_dashboards.tools.adapters import build_runtime_toolkit


@dataclass(frozen=True)
class _AppBinding:
    ingress: Any
    principal: PrincipalRef
    lease: CapabilityLease


class _DashboardSource:
    def __init__(self, owner, binding):
        self.owner, self.binding = owner, binding
        self.toolkit = build_runtime_toolkit(service=owner.service, access_provider=self.access)
        self.functions = {**self.toolkit.functions, **self.toolkit.async_functions}
        for function in self.functions.values():
            function.process_entrypoint()

    async def access(self):
        context = current_execution_context()
        self.owner.check(self.binding, context, current_ingress_identity())
        return AccessContext.from_on_behalf_identity(self.binding.ingress.turn_context.on_behalf_identity)

    async def discover(self, context):
        try:
            self.owner.check(self.binding, context, current_ingress_identity())
        except (PermissionError, CapabilityUnavailable):
            return ()
        return tuple(ToolDefinition(name, function.description or '', function.parameters)
                     for name, function in self.functions.items())

    async def call_tool(self, name, arguments, context):
        self.owner.check(self.binding, context, current_ingress_identity())
        return await self.functions[name].entrypoint(**arguments)


class DashboardCapabilities:
    def __init__(self, gateway, agent, *, service=None):
        self.gateway, self.agent = gateway, agent
        self.service = service if service is not None else service_for_gateway(gateway)
        self.bindings: dict[str, _AppBinding] = {}
        self.registrations: set[str] = set()

    def register_connection(self, connection_id, frame):
        if (frame != {'type':'app_capability_register','product':'openagent-app','dashboard_tools':1}
                or type(frame.get('dashboard_tools')) is not int):
            raise ValueError('Unsupported App capability registration')
        socket = getattr(self.gateway,'clients',{}).get(connection_id)
        if socket is None or getattr(socket,'closed',False):
            raise PermissionError('App connection is unavailable')
        self.registrations.add(connection_id)
        return {'type':'app_capability_registered','connection_id':connection_id,'dashboard_tools':1}

    def resolve_ingress(self, connection_id, identity, request_id, *, client_instance_id=None):
        capabilities=tuple(sorted({'dashboard_tools':1,'custom_ui_version':1,'inline_ui':True,'sidebar_ui':True}.items()))
        epoch=getattr(self.gateway,'_chat_client_auth_epochs',{}).get(connection_id)
        if not isinstance(epoch,int):
            raise PermissionError('App connection is unavailable')
        ingress=TrustedIngressIdentity(identity.device_id,connection_id,client_instance_id,epoch,
            TrustedTurnContext(identity,'openagent-app',capabilities,request_id=request_id))
        if not self.live(ingress):
            raise PermissionError('The exact registered App connection is unavailable')
        return ingress

    @staticmethod
    def offered(ingress) -> bool:
        turn = getattr(ingress, 'turn_context', None)
        if turn is None or turn.client_kind not in {'desktop', 'webapp', 'webapp-chat', 'openagent-app'}:
            return False
        capabilities = dict(turn.client_capabilities)
        return (type(capabilities.get('dashboard_tools')) is int and capabilities['dashboard_tools'] == 1
                and capabilities.get('custom_ui_version') == 1
                and (capabilities.get('inline_ui') is True or capabilities.get('sidebar_ui') is True))

    def live(self, ingress) -> bool:
        if not self.offered(ingress):
            return False
        connection = ingress.connection_id
        if connection not in self.registrations:
            return False
        socket = getattr(self.gateway, 'clients', {}).get(connection)
        if socket is None or getattr(socket, 'closed', False):
            return False
        if getattr(self.gateway, '_chat_client_devices', {}).get(connection) != ingress.device_id:
            return False
        if getattr(self.gateway, '_chat_client_auth_epochs', {}).get(connection) != ingress.auth_epoch:
            return False
        identity = ingress.turn_context.on_behalf_identity
        if identity is None or identity.auth_kind != 'device_cert':
            return False
        auth_state = getattr(getattr(self.gateway, '_network_state', None), 'auth_state', None)
        epoch_reader = getattr(auth_state, 'device_epoch', None)
        try:
            pubkey = bytes.fromhex(ingress.device_id)
        except (TypeError, ValueError):
            return False
        return (callable(epoch_reader) and epoch_reader(pubkey) == ingress.auth_epoch
                and pubkey not in getattr(auth_state, 'revoked_pubkeys', set()))

    @staticmethod
    def same_registration(left, right):
        # request_id changes on every message; it is not connection identity.
        return (left is not None and right is not None
                and (left.device_id,left.connection_id,left.auth_epoch) == (right.device_id,right.connection_id,right.auth_epoch)
                and left.turn_context.on_behalf_identity == right.turn_context.on_behalf_identity)

    def check(self, binding, context, ingress):
        if context is None or context.deferred or binding.lease not in context.capabilities:
            raise CapabilityUnavailable('Dashboard capability is unavailable for this execution')
        if (not self.same_registration(ingress, binding.ingress)
                or not self.live(binding.ingress)):
            raise CapabilityUnavailable('The exact originating App connection is unavailable')
        if context.initiator != binding.principal:
            raise PermissionError('Dashboard source belongs to another principal')

    async def leases_for_context(self, catalog, context):
        ingress = current_ingress_identity()
        if context.deferred or not self.live(ingress):
            return ()
        identity = ingress.turn_context.on_behalf_identity
        if identity is None or identity.device_id != ingress.device_id:
            raise PermissionError('Dashboard registration requires verified App identity')
        principal = PrincipalRef('openagent', identity.tenant_id, identity.handle, identity.principal_type)
        if context.initiator != principal:
            raise PermissionError('Dashboard registration principal differs from this turn')
        source_id = f'app-dashboard/{ingress.connection_id}/{ingress.auth_epoch}'
        existing = self.bindings.get(source_id)
        if existing is not None:
            if not self.same_registration(existing.ingress, ingress):
                raise PermissionError('App registration changed inside a connection')
            return (existing.lease,)
        lease = CapabilityLease(source_id, ingress.connection_id, str(ingress.auth_epoch))
        binding = _AppBinding(ingress, principal, lease)
        source = _DashboardSource(self, binding)
        catalog.register(source_id, source, source, target_label='OpenAgent App dashboards', lease=lease)
        self.bindings[source_id] = binding
        return (lease,)

    def authorize_source(self, context, action, resource, *, audience=()):
        source_id = resource.resource_id if resource.kind == 'capability' else resource.resource_id.rsplit('/', 1)[0]
        binding = self.bindings.get(source_id)
        if binding is None:
            return None
        if action not in {'tool.discover', 'tool.call', 'tool.publish'}:
            return False
        try:
            self.check(binding, context, current_ingress_identity())
        except (PermissionError, CapabilityUnavailable):
            return False
        # Sharing is a separate product policy. A private view must not appear
        # in a shared conversation merely because its initiator can read it.
        return context.audience == (binding.principal,)

    def revoke_connection(self, catalog, connection_id):
        self.registrations.discard(connection_id)
        for source_id, binding in tuple(self.bindings.items()):
            if binding.ingress.connection_id == connection_id:
                catalog.revoke_lease(binding.lease)
                del self.bindings[source_id]

    async def content_validator(self, *, part, session_id, principal, db, ingress=None):
        """Recheck an immutable inline view reference before delivery."""
        if principal is None or db is None or not self.live(ingress):
            return None
        if ingress.turn_context.on_behalf_identity != principal:
            return None
        try:
            runtime_service = getattr(self.gateway, 'runtime_service', None)
            if runtime_service is None:
                return None
            context = await runtime_service.authorizer.context_for_identity(principal, session_id)
            if not await runtime_service.authorizer.authorize(context, 'run.publish',
                    ResourceRef('session', context.tenant_id, session_id), audience=context.audience):
                return None
            access = AccessContext.from_on_behalf_identity(principal)
            view_id = str(part.get('view_id') or '')
            revision = int(part.get('revision') or 0)
            linked = await self.service.resolve_inline_ref(view_id, revision, session_id=session_id, access=access)
        except (PermissionError, ValueError, TypeError):
            return None
        if linked is None:
            return None
        return {'kind':'ui_view', 'view_id':view_id, 'revision':revision,
                'title':linked.get('title'), 'status':linked.get('status'), 'expires_at':linked.get('expiresAt')}
