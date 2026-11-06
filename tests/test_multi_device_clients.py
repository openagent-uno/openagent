"""Standalone ownership, persistent inventory, exact dispatch and desktop API."""
import asyncio
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from openagent_core.capabilities import CapabilityCatalog, CapabilityUnavailable
from openagent_core.contracts import ExecutionContext, PrincipalRef, ResourceRef, CapabilityLease
from openagent_core.core.on_behalf_context import OnBehalfIdentity, install_on_behalf_identity, reset_on_behalf_identity
from openagent_server.device_directory import DeviceDirectory
from openagent_server.gateway.capabilities import CapabilityRegistry, ClientCapabilityError
from openagent_server.gateway.api.devices import computer_arguments, computer_tools
from openagent_server.runtime_service import NativeRuntimeService
from openagent_server.runtime_access import NativeRuntimeAuthorizer
from test_runtime_access import Request


class Socket:
    closed = False
    async def close(self, **_): self.closed = True


class MultiDeviceClients(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = DeviceDirectory(Path(self.temp.name) / 'devices.sqlite3')
        self.registry = CapabilityRegistry()
        self.registry.record_device_use = self.directory.used
        self.identity = OnBehalfIdentity('network', 'user', 'alice', 'origin')
        self.sent = []
        self.connections = []
        self.policy = self
        self.catalog = CapabilityCatalog(self)
        self.service = NativeRuntimeService.__new__(NativeRuntimeService)
        self.binding_valid = True
        self.active_users = {'alice'}
        async def authorized(request, certificate): return self.binding_valid
        self.service.gateway = SimpleNamespace(capabilities=self.registry, _request_device_still_authorized=authorized)
        self.service.authorizer = NativeRuntimeAuthorizer(self.service.gateway, Path(self.temp.name) / 'state.sqlite3')
        self.identity = await self.service.authorizer.bind_request(Request(self.service.gateway, 'alice'))
        async def active(principal): return principal.subject_id in self.active_users
        self.service.directory = SimpleNamespace(principal_active=active)
        self.service.agent = SimpleNamespace(config={})
        async def unrelated(*args): return None
        self.service.official_connectors = SimpleNamespace(authorize_source=unrelated)
        self.service.runtime = SimpleNamespace(capabilities=self.catalog)
        self.service.dashboards = None
        self.service._interactive_sources = {}
        self.service._interactive_leases = {}
        self.service._interactive_origins = {}
        p = PrincipalRef('openagent', 'network', 'alice')
        self.context = ExecutionContext(p, p, p, 'session', 'agent', (p,),
            ingress_id=self.service.authorizer._identity_bindings[self.service.authorizer.binding_id(self.identity)])
        self.token = install_on_behalf_identity(self.identity)

    async def authorize(self, context, action, resource, *, audience=()):
        return await self.service._authorize_source(context, action, resource, audience=audience)

    async def asyncTearDown(self):
        reset_on_behalf_identity(self.token)
        await self.registry.close_all()
        self.temp.cleanup()

    async def connect(self, device='laptop', owner='alice', network='network', instance='app', generation=1, kind='user'):
        async def send(ws, frame):
            self.sent.append((device, frame))
            if frame['type'] == 'client_tool_call':
                self.registry.resolve_result(conn, {'call_id': frame['call_id'], 'generation': generation,
                    'result': {'content': [{'type': 'text', 'text': device}]}})
            return True
        conn = await self.registry.register(device_id=device, account_id=network, network_id=network,
            owner_handle=owner, owner_kind=kind, client_instance_id=instance, generation=generation,
            device_label=device.title(), ws=Socket(), send_json=send,
            servers=[{'name': 'computer-control', 'tools': [{'name': 'computer', 'classification': 'read_only',
                'input_schema': {'type': 'object', 'properties': {'action': {'$ref': '#/$defs/Action'}},
                                 '$defs': {'Action': {'enum': ['get_screenshot', 'left_click']}}}}]}])
        self.connections.append(conn)
        await self.directory.remember(conn)
        return conn

    async def test_only_same_authenticated_human_and_network_share_capabilities(self):
        await self.connect()
        await self.connect('workstation')
        await self.connect('bob-device', owner='bob')
        await self.connect('foreign-device', network='foreign')
        await self.connect('agent-device', kind='agent')
        leases = await self.service._capability_context(self.context)
        context = replace(self.context, capabilities=leases)
        targets = computer_tools(await self.catalog.discover(context))
        self.assertEqual({'Laptop', 'Workstation'}, {t.target_label for t in targets})
        for target in targets:
            await self.catalog.call_tool(target.tool_ref, {'action': 'get_screenshot'}, context)
        self.assertEqual({'laptop', 'workstation'}, {device for device, frame in self.sent if frame['type'] == 'client_tool_call'})
        used = await self.directory.session_devices('network', 'session', self.registry)
        self.assertEqual({'Laptop', 'Workstation'}, {d['label'] for d in used})
        self.assertFalse(await self.directory.session_devices('foreign', 'session', self.registry))

    async def test_offline_inventory_survives_restart_but_never_confers_authority(self):
        conn = await self.connect()
        self.assertTrue((await self.directory.devices(self.identity, self.registry))[0]['online'])
        leases = await self.service._capability_context(self.context)
        context = replace(self.context, capabilities=leases)
        target = (await self.catalog.discover(context))[0]
        await self.registry.unregister(conn)
        self.assertFalse((await self.directory.devices(self.identity, self.registry))[0]['online'])
        restarted = DeviceDirectory(self.directory.path)
        empty_registry = CapabilityRegistry()
        self.assertEqual('Laptop', (await restarted.devices(self.identity, empty_registry))[0]['label'])
        self.assertFalse(await self.service._capability_context(self.context))
        with self.assertRaises((CapabilityUnavailable, ClientCapabilityError)):
            await self.catalog.call_tool(target.tool_ref, {'action': 'left_click'}, context)
        self.assertFalse(self.sent)

    async def test_revoke_and_new_generation_do_not_redirect_old_references(self):
        conn = await self.connect()
        leases = await self.service._capability_context(self.context)
        context = replace(self.context, capabilities=leases)
        target = (await self.catalog.discover(context))[0]
        await self.registry.close_device(conn.device_id, revocation_epoch=1)
        self.service.revoke_device_origin(conn)
        with self.assertRaises((CapabilityUnavailable, ClientCapabilityError)):
            await self.catalog.call_tool(target.tool_ref, {'action': 'get_screenshot'}, context)
        self.assertFalse([frame for _, frame in self.sent if frame['type'] == 'client_tool_call'])

    async def test_unbound_shared_background_and_agent_contexts_receive_no_device_leases(self):
        await self.connect()
        other = PrincipalRef('openagent', 'network', 'bob')
        for context in (replace(self.context, ingress_id=None), replace(self.context, ingress_id='forged'),
                        replace(self.context, audience=(self.context.initiator, other)),
                        replace(self.context, deferred=True, delegation_id='task', capabilities=()),
                        replace(self.context, author=replace(other, kind='agent'))):
            self.assertFalse(await self.service._capability_context(context))
        self.binding_valid = False
        self.assertFalse(await self.service._capability_context(self.context))

    async def test_mapped_private_channels_share_devices_and_recheck_current_mapping(self):
        await self.connect()
        await self.connect('bob-device', owner='bob')
        for provider in ('slack', 'discord'):
            with self.subTest(provider=provider):
                self.binding_valid = True
                base = replace(self.context, session_id=provider, ingress_id=None)
                async def valid(): return self.binding_valid
                context = self.service.authorizer.bind_channel(base, valid)
                leases = await self.service._capability_context(context)
                context = await self.service.authorizer.grant_channel_capabilities(context, leases)
                self.assertIsNotNone(await self.service.authorizer._channel(context))
                targets = await self.catalog.discover(context)
                self.assertEqual({'Laptop'}, {t.target_label for t in targets})
                await self.catalog.call_tool(targets[0].tool_ref, {'action':'get_screenshot'}, context)
                forged = replace(context, capabilities=(*leases, CapabilityLease('invented', 'app', '1')))
                self.assertIsNone(await self.service.authorizer._channel(forged))
                self.binding_valid = False
                self.assertFalse(await self.catalog.discover(context))
                with self.assertRaises((PermissionError, CapabilityUnavailable)):
                    await self.catalog.call_tool(targets[0].tool_ref, {'action':'get_screenshot'}, context)

    async def test_explicit_private_bridge_mapping_is_not_a_user_alias_and_is_revocable(self):
        await self.connect()
        await self.connect('bob-device', owner='bob')
        for provider, prefix in (('telegram','tg:'), ('whatsapp','wa:')):
            with self.subTest(provider=provider):
                sender = '155490357'
                self.service.agent.config = {'channels':{provider:{'allowed_users':[sender]}},
                    'runtime_tool_audiences':{'vault_owner_channels':{provider:[sender]},
                                            'device_owner_channels':{provider:{sender:'alice'}}}}
                identity = await self.service.authorizer.bind_request(Request(self.service.gateway, '__bridge_'+provider))
                p = PrincipalRef('openagent', 'network', identity.handle)
                context = ExecutionContext(p,p,p,prefix+sender,'agent',(p,),
                    ingress_id=self.service.authorizer._identity_bindings[self.service.authorizer.binding_id(identity)])
                leases = await self.service._capability_context(context)
                context = replace(context, capabilities=leases)
                self.assertEqual('__bridge_'+provider, context.initiator.subject_id)
                targets = await self.catalog.discover(context)
                self.assertEqual({'Laptop'}, {t.target_label for t in targets})
                for changed in (replace(context, session_id=prefix+'999'), replace(context, audience=(p,self.context.initiator))):
                    self.assertFalse(await self.service._capability_context(changed))
                self.active_users.clear()
                self.assertFalse(await self.catalog.discover(context))
                self.active_users.add('alice')
                del self.service.agent.config['runtime_tool_audiences']['device_owner_channels'][provider][sender]
                self.assertFalse(await self.catalog.discover(context))
                with self.assertRaises((PermissionError, CapabilityUnavailable)):
                    await self.catalog.call_tool(targets[0].tool_ref, {'action':'get_screenshot'}, context)

    def test_desktop_api_rejects_injected_tools_paths_recordings_and_invalid_coordinates(self):
        for body in ({'tool_ref': 'x', 'action': 'start_screen_recording'},
                     {'tool_ref': 'x', 'action': 'get_screenshot', 'server': 'shell'},
                     {'tool_ref': 'x', 'action': 'left_click', 'coordinate': [True, 1]},
                     {'tool_ref': 'x', 'action': 'left_click', 'coordinate': [-1, 1]},
                     {'tool_ref': 'x', 'action': 'type', 'text': 'a' * 16385}):
            with self.assertRaises(ValueError): computer_arguments(body)
        self.assertEqual({'action': 'left_click', 'coordinate': [5, 8]}, computer_arguments({'tool_ref': 'x', 'action': 'left_click', 'coordinate': [5, 8]}))

    async def test_process_restart_keeps_one_device_card_and_delete_removes_session_usage(self):
        first = await self.connect(instance='process-one')
        await self.directory.used(first, 'session')
        await self.registry.unregister(first)
        second = await self.connect(instance='process-two')
        await self.directory.used(second, 'session')
        self.assertEqual(1, len(await self.directory.devices(self.identity, self.registry)))
        self.assertEqual(1, len(await self.directory.session_devices('network', 'session', self.registry)))
        await self.directory.forget_session('session')
        self.assertFalse(await self.directory.session_devices('network', 'session', self.registry))
