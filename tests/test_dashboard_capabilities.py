from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from openagent_core.capabilities import CapabilityCatalog, CapabilityUnavailable
from openagent_core.contracts import ExecutionContext, PrincipalRef, require_authorized
from openagent_core.core.execution_origin import TrustedIngressIdentity, TrustedTurnContext, ingress_identity_scope
from openagent_core.core.on_behalf_context import OnBehalfIdentity
from openagent_core.core.paths import set_agent_dir
from openagent_core.memory.db import MemoryDB
from openagent_core.runtime import execution_scope
from openagent_dashboards.migration import ensure_custom_views_storage
from openagent_dashboards.service import CustomViewService
from openagent_server.dashboard_capabilities import DashboardCapabilities


class DashboardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        set_agent_dir(self.path)
        self.db = MemoryDB(str(self.path/'state.sqlite3'))
        async def migrate(conn):
            await ensure_custom_views_storage(conn, app_version='test')
        self.db.add_migration(migrate)
        await self.db.connect()
        self.service = CustomViewService(self.db)
        self.epoch = 7
        self.device = 'ab' * 32
        self.identity = OnBehalfIdentity('network','user','alice',self.device,'device_cert')
        self.principal = PrincipalRef('openagent','network','alice')
        self.context = ExecutionContext(self.principal,self.principal,self.principal,'session','agent',(self.principal,))
        caps = tuple(sorted({'dashboard_tools':1,'custom_ui_version':1,'inline_ui':True,'sidebar_ui':True}.items()))
        self.ingress = TrustedIngressIdentity(self.device,'connection',None,self.epoch,
            TrustedTurnContext(self.identity,'webapp',caps))
        self.socket = SimpleNamespace(closed=False)
        self.gateway = SimpleNamespace(clients={'connection':self.socket},
            _chat_client_devices={'connection':self.device},
            _chat_client_auth_epochs={'connection':self.epoch},
            _chat_client_render_contexts={'connection':('webapp',caps)},
            _network_state=SimpleNamespace(auth_state=SimpleNamespace(device_epoch=lambda _:self.epoch, revoked_pubkeys=set())))
        self.adapter = DashboardCapabilities(self.gateway,SimpleNamespace(memory_db=self.db),service=self.service)
        self.adapter.register_connection('connection', {'type':'app_capability_register','product':'openagent-app','dashboard_tools':1})
        self.catalog = CapabilityCatalog(self)
        self.runtime = SimpleNamespace(capabilities=self.catalog,settings=SimpleNamespace(workspace=self.path),
            authorize=self.authorize_required,services=SimpleNamespace(store=self))

    async def authorize(self, context, action, resource, *, audience=()):
        return self.adapter.authorize_source(context,action,resource,audience=audience) is True

    async def authorize_required(self, context, action, resource, *, audience=()):
        await require_authorized(self,context,action,resource,audience=audience)

    async def begin_tool(self, *args, **kwargs): pass
    async def finish_tool(self, *args, **kwargs): pass

    async def asyncTearDown(self):
        await self.service.close()
        await self.db.close()
        self.temp.cleanup()
        set_agent_dir(None)

    async def activate(self, ingress=None):
        with ingress_identity_scope(ingress or self.ingress):
            leases = await self.adapter.leases_for_context(self.catalog,self.context)
        return replace(self.context, capabilities=leases)

    async def test_app_without_computer_consent_can_create_and_read_persistent_view(self):
        context = await self.activate()
        self.assertIsNone(self.ingress.client_instance_id)
        with ingress_identity_scope(self.ingress), execution_scope(self.runtime,context,'run'):
            tools={d.name:d for d in await self.catalog.discover(context)}
            self.assertIn('ui_create_view',tools)
            result=await self.catalog.call_tool(tools['ui_create_view'].tool_ref,
                {'title':'Dashboard','markup':'<text>Hello</text>'},context)
            self.assertTrue(result['ok'],result)
            view_id=result['view']['id']
            read=await self.catalog.call_tool(tools['ui_get_view'].tool_ref,{'view_id':view_id},context)
            self.assertEqual(read['view']['title'],'Dashboard')
        # Persisted product data survives registration cleanup; later reads are
        # still separately authorized by the product repository.
        self.adapter.revoke_connection(self.catalog,'connection')
        from openagent_core.memory.operational.access import AccessContext
        view=await self.service.get(view_id,AccessContext.from_on_behalf_identity(self.identity))
        self.assertEqual(view['title'],'Dashboard')
        self.assertEqual(await self.catalog.discover(context),())

    async def test_cli_channel_deferred_other_principal_and_socket_never_inherit(self):
        context=await self.activate()
        with ingress_identity_scope(self.ingress):
            tools=await self.catalog.discover(context)
        self.assertTrue(tools)
        for ingress, candidate in [(None,context), (replace(self.ingress,connection_id='cli'),context),
            (self.ingress,replace(context,deferred=True,capabilities=(),delegation_id='explicit-fixture')),
            (self.ingress,replace(context,initiator=PrincipalRef('openagent','network','bob')))]:
            with self.subTest(ingress=ingress,candidate=candidate), ingress_identity_scope(ingress):
                self.assertEqual(await self.catalog.discover(candidate),())
                with self.assertRaises((PermissionError,CapabilityUnavailable)):
                    await self.catalog.call_tool(tools[0].tool_ref,{},candidate)
        with ingress_identity_scope(replace(self.ingress,turn_context=replace(self.ingress.turn_context,client_kind='cli'))):
            self.assertEqual(await self.adapter.leases_for_context(self.catalog,self.context),())

    async def test_current_revocation_and_disconnect_invalidate_exact_refs(self):
        context=await self.activate()
        with ingress_identity_scope(self.ingress):
            tool=(await self.catalog.discover(context))[0]
            self.epoch+=1
            self.assertEqual(await self.catalog.discover(context),())
            with self.assertRaises((PermissionError,CapabilityUnavailable)):
                await self.catalog.call_tool(tool.tool_ref,{},context)
            self.epoch-=1
            self.socket.closed=True
            self.assertEqual(await self.catalog.discover(context),())

    async def test_request_id_changes_preserve_registration_but_shared_output_is_denied(self):
        first=await self.activate()
        second=await self.activate(replace(self.ingress,turn_context=replace(self.ingress.turn_context,request_id='next')))
        self.assertEqual(first.capabilities,second.capabilities)
        with ingress_identity_scope(self.ingress):
            shared=replace(first,audience=(self.principal,PrincipalRef('openagent','network','bob')))
            self.assertEqual(await self.catalog.discover(shared),())

    async def test_http_binding_cannot_borrow_another_devices_connection(self):
        ingress=self.adapter.resolve_ingress('connection',self.identity,'http-request')
        self.assertEqual(ingress.connection_id,'connection')
        self.assertEqual(ingress.turn_context.request_id,'http-request')
        with self.assertRaises(PermissionError):
            self.adapter.resolve_ingress('connection',replace(self.identity,device_id='cd'*32),'other')
        with self.assertRaises(PermissionError):
            self.adapter.resolve_ingress('guessed',self.identity,'other')
        with self.assertRaises(ValueError):
            self.adapter.register_connection('connection',{'type':'app_capability_register','product':'glasspalace','dashboard_tools':1})

    async def test_inline_references_require_current_session_and_current_publication_rights(self):
        context=await self.activate()
        with ingress_identity_scope(self.ingress), execution_scope(self.runtime,context,'run'):
            tools={d.name:d for d in await self.catalog.discover(context)}
            bad=await self.catalog.call_tool(tools['ui_create_view'].tool_ref,
                {'title':'Inline','markup':'<text>Private</text>','surface':'inline','session_id':'other-session'},context)
            self.assertFalse(bad['ok'])
            view=await self.catalog.call_tool(tools['ui_create_view'].tool_ref,
                {'title':'Inline','markup':'<text>Private</text>','surface':'inline','session_id':'session'},context)
            self.assertTrue(view['ok'],view)
        allowed=True
        async def context_for_identity(identity,session): return self.context
        async def authorize(*args,**kwargs): return allowed
        self.gateway.runtime_service=SimpleNamespace(authorizer=SimpleNamespace(context_for_identity=context_for_identity,authorize=authorize))
        part={'kind':'ui_view','view_id':view['view']['id'],'revision':view['view']['revision']}
        kwargs=dict(part=part,session_id='session',principal=self.identity,db=self.db,ingress=self.ingress)
        self.assertEqual((await self.adapter.content_validator(**kwargs))['title'],'Inline')
        self.assertIsNone(await self.adapter.content_validator(**{**kwargs,'session_id':'other'}))
        allowed=False
        self.assertIsNone(await self.adapter.content_validator(**kwargs))


if __name__ == '__main__': unittest.main()
