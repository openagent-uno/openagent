"""Trusted product bindings for shared SDK schema selectors and Core lineage."""
from __future__ import annotations
from contextvars import ContextVar
from dataclasses import dataclass

from openagent_core.content_privacy import ContentOrigin, ContentFragment, ToolResultProvenance, PrivacyFence
from openagent_connectors.privacy import invocation_selection, result_fragments
from .connector_privacy import grant_generation


@dataclass(frozen=True)
class ConnectionScope:
    tenant: str
    app: str
    group: str
    generation: int

    @classmethod
    def from_host(cls, row, token, context):
        if (row['provider']!='shopify' or not row.get('group_id') or not row.get('app_id')
                or token.get('group')!=row['group_id'] or token.get('app_id')!=row['app_id']
                or row['tenant_id']!=context.tenant_id):
            raise PermissionError('Connector scope is not a verified local recipient')
        return cls(context.tenant_id,row['app_id'],row['group_id'],grant_generation(token['authorized_at']))

    def origin(self, selection):
        # Nonpersonal provider fields still retain source/shop/consent lineage.
        return ContentOrigin(self.tenant,'shopify/'+self.app,self.group,self.generation,
                             selection.subjects,nonpersonal=selection.nonpersonal)


class OfficialConnectorProvenance:
    def __init__(self, service, connection_id, publisher):
        self.service,self.connection_id,self.publisher=service,connection_id,publisher
        self._admitted=ContextVar('official_connector_privacy_admission',default=None)

    async def scope(self, context):
        row=await self.service.record(self.connection_id)
        if not self.service.can_use(context,row):
            raise PermissionError('Connector binding is unavailable')
        return ConnectionScope.from_host(row,self.service.decrypt(row),context)

    async def invocation(self, descriptor, arguments, context, call_id):
        if descriptor.source_id!=self.service.source_id(self.connection_id):
            raise PermissionError('Invocation belongs to another local connection')
        scope=await self.scope(context)
        selection=invocation_selection('shopify',descriptor.name,arguments)
        if not selection.subjects and not selection.nonpersonal:
            raise PrivacyFence('This managed operation lacks a reviewed invocation schema')
        from openagent_core.runtime import current_run_id
        inherited=await self.publisher.origins_for_execution(context,current_run_id())
        if descriptor.name=='commerce.shopify.customers.update':
            # The qualified mutation changes the same provider entity only.
            # It cannot copy another customer's/store's protected context into
            # that destination. Other remote writers remain fenced by catalog.
            if descriptor.name!='commerce.shopify.customers.update':
                raise PrivacyFence('This remote writer has no qualified privacy binding')
            for origin in inherited:
                same=(origin.tenant_id==scope.tenant and origin.source_id=='shopify/'+scope.app
                      and origin.group_id==scope.group and origin.generation==scope.generation)
                if not same or (not origin.nonpersonal and (not origin.subjects or not set(origin.subjects)<=set(selection.subjects))):
                    raise PrivacyFence('A remote mutation cannot receive another protected entity')
        self._admitted.set((descriptor.name,call_id,scope,False))
        return (scope.origin(selection),)

    async def before_io(self, name, context):
        admitted=self._admitted.get()
        if admitted is None or admitted[0]!=name or admitted[3] or admitted[2]!=await self.scope(context):
            raise PermissionError('Connector authorization changed before API execution')
        self._admitted.set((*admitted[:3],True))

    async def result(self, descriptor, value, context, call_id):
        admitted=self._admitted.get()
        if admitted is None or not admitted[3] or admitted[:2]!=(descriptor.name,call_id):
            raise PermissionError('Provider result is not bound to its admitted invocation')
        scope=await self.scope(context)
        if scope!=admitted[2]:
            raise PermissionError('Provider result belongs to another authorization')
        fragments=result_fragments('shopify',descriptor.name,value)
        if any(not item.selection.subjects and not item.selection.nonpersonal for item in fragments):
            raise PrivacyFence('This provider response contains an unqualified privacy field')
        plan=ToolResultProvenance(tuple(ContentFragment(item.path,(scope.origin(item.selection),))
                                       for item in fragments))
        self._admitted.set(None)
        return plan


async def independent_result(descriptor, value, context, call_id):
    """An unrelated official read does not acquire the run's Shopify identity."""
    return ToolResultProvenance((ContentFragment((),()),))
