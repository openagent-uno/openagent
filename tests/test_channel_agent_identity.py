"""Owner persona tools across device and mapped/provider channel admission."""
import copy
import time
from dataclasses import replace
from types import SimpleNamespace

import pytest
import yaml

from openagent_core import Runtime, RuntimeServices, RuntimeSettings
from openagent_core.contracts import PrincipalRef, RunRequest
from openagent_core.memory.db import MemoryDB
from openagent_core.runtime import execution_scope
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_product_config.agent_identity import AgentIdentityPermissionError, AgentIdentityService
from openagent_product_config.tools.agent_manager.adapters import build_runtime_toolkit
from openagent_server.bridges.session_identity import gateway_bridge_session_id
from openagent_server.runtime_service import NativeRuntimeService
from openagent_server.runtime_access import NativeRuntimeAuthorizer
from openagent_server.runtime_directory import NativeRuntimeDirectory
from openagent_storage_sqlite import SqliteRuntimeStore

PROVIDERS = ('telegram', 'whatsapp', 'slack', 'discord')
SENDER = '123456789'


@pytest.fixture(params=PROVIDERS)
async def owner_channel(tmp_path, request):
    provider = request.param
    db = MemoryDB(str(tmp_path / 'state.sqlite'))
    await db.connect()
    directory_store = CoordinatorStore(db)
    await directory_store.set_network_role(role='coordinator', network_id='network', name='fixture')
    for handle in ('alice', 'bob'):
        await directory_store.create_user(handle=handle, pake_record=b'fixture', pake_algo='fixture')
    await directory_store.register_agent(handle='agent', node_id='node', owner_handle='alice')
    config = {'name': 'Friday', 'system_prompt': 'Original persona',
        'channels': {provider: {'allowed_users': [SENDER]}},
        'runtime_tool_audiences': {'vault_owner_channels': {provider: [SENDER]}}}
    channel = config['channels'][provider]
    if provider == 'telegram': channel['token'] = '123456:fixture'
    if provider == 'whatsapp': channel['green_api_id'] = '123456'
    if provider in ('slack', 'discord'):
        channel['identity'] = dict(tenant_id='network', account_id='account', user_bindings={SENDER: 'alice'})
    path = tmp_path / 'openagent.yaml'
    path.write_text(yaml.safe_dump(config))
    agent = SimpleNamespace(name='Friday', system_prompt='Original persona', config=config, memory_db=db)
    revoked = set()
    async def authorized(req, cert): return cert.handle not in revoked
    gateway = SimpleNamespace(agent=agent, _request_device_still_authorized=authorized,
        _network_state=SimpleNamespace(identity=SimpleNamespace(public_hex='node')))
    service = object.__new__(NativeRuntimeService)
    service.agent, service.gateway = agent, gateway
    service.dashboards = None
    service.authorizer = NativeRuntimeAuthorizer(gateway, db.db_path)
    service.directory = NativeRuntimeDirectory(gateway, agent)
    store = SqliteRuntimeStore(db.db_path)
    await store.start()
    service.runtime = Runtime(RuntimeSettings('Friday', tmp_path), RuntimeServices(store, None, service.authorizer))
    gateway.runtime_service = service
    host, bridge, actor = None, None, None
    if provider in ('slack', 'discord'):
        from openagent_channel_bridges.base import BaseBridge
        from openagent_channel_bridges.contracts import BridgeContext
        from openagent_server.bridges.native_transport import NativeChannelTransport
        class Provider(BaseBridge):
            name = provider
            async def _delivery_context(self, context):
                return replace(context, audience_ids=(SENDER,), audience_complete=True, audience_verified_at=time.time())
        host = NativeChannelTransport(service, provider, provider)
        bridge = Provider(transport=host, binding_id=provider)
        external = BridgeContext(provider, provider, 'account', SENDER, 'direct-conversation', 'event',
            conversation_kind='direct', audience_ids=(SENDER,), audience_complete=True, audience_verified_at=time.time())
        context = await host._execution(external)
    else:
        subject = '__bridge_' + provider
        class Request(dict): pass
        req = Request(device_cert=SimpleNamespace(network_id='network', handle=subject,
            device_pubkey_hex='device-' + provider, capabilities=()), network_id='network', user_handle=subject,
            client_id='device-' + provider, auth_kind='device_cert', device_auth_epoch=1)
        req.app = {'gateway': gateway}
        actor = await service.authorizer.bind_request(req)
        hint = ('tg:' if provider == 'telegram' else 'wa:') + SENDER
        session = gateway_bridge_session_id(provider, provider, '123456', SENDER,
            SENDER if provider == 'telegram' else SENDER + '@c.us', None, hint)
        context = await service.authorizer.context_for_identity(actor, session)
    await store.accept(RunRequest('seed', context.session_id, 'seed', 'seed'), context)
    identity = AgentIdentityService(agent=agent, db=db, config_path=path, gateway=gateway)
    toolkit = build_runtime_toolkit(pool=SimpleNamespace(agent_runtime=agent, gateway_runtime=gateway))
    agent.config['_config_path'] = str(path)
    value = SimpleNamespace(provider=provider, db=db, store=store, service=service, gateway=gateway,
        agent=agent, context=context, actor=actor, identity=identity, toolkit=toolkit, path=path,
        host=host, bridge=bridge, revoked=revoked)
    try: yield value
    finally:
        if host is not None: await host.stop()
        await store.close()
        await db.close()


async def test_owner_can_read_update_and_hot_apply_persona_from_each_channel(owner_channel):
    f = owner_channel
    original = yaml.safe_load(f.path.read_text())
    with execution_scope(f.service.runtime, f.context, 'seed'):
        before = await f.toolkit.async_functions['agent_get_identity'].entrypoint()
        from openagent_server.memory_access import NativeMemoryAccess
        from openagent_core.contracts import ResourceRef
        memory = NativeMemoryAccess(f.service)
        assert await memory.authorize(f.context, 'memory.read', ResourceRef('vault-note', 'network', 'self/identity.md'))
        assert await memory.authorize(f.context, 'memory.publish', ResourceRef('vault-note', 'network', 'self/identity.md'), audience=f.context.audience)
        from openagent_core.contracts import ResourceRef
        for action in ('catalog.manage', 'automation.manage'):
            assert await f.service._authorize_source(f.context, action,
                ResourceRef('agent', 'network', 'Friday'), audience=f.context.audience)
        result = await f.toolkit.async_functions['agent_update_identity'].entrypoint(
            system_prompt='Updated owner persona', expected_revision=before['revision'])
    saved = yaml.safe_load(f.path.read_text())
    assert result['changed'] == ['system_prompt'] and 'system_prompt' not in result
    assert saved == {**original, 'system_prompt': 'Updated owner persona'}
    assert f.agent.system_prompt == 'Updated owner persona'
    assert result['framework_prompt_mutable'] is False and result['restart_required'] is False


async def test_global_persona_denies_shared_deferred_spoofed_or_other_runtime_turn(owner_channel):
    f = owner_channel
    before = f.path.read_bytes()
    other = PrincipalRef('openagent', 'network', 'bob')
    for context in (
        replace(f.context, audience=(f.context.initiator, other)),
        replace(f.context, deferred=True, delegation_id='background'), replace(f.context, delegation_id='delegated'),
        replace(f.context, parent_run_id='parent'), replace(f.context, author=other),
        replace(f.context, initiator=other, author=other, authority=other, audience=(other,)),
        replace(f.context, session_id='different-session'),
    ):
        with execution_scope(f.service.runtime, context, 'seed'):
            with pytest.raises(AgentIdentityPermissionError):
                await f.identity.update(f.actor, system_prompt='Unauthorized')
        assert f.path.read_bytes() == before
    with execution_scope(object(), f.context, 'seed'):
        with pytest.raises(AgentIdentityPermissionError): await f.identity.get(f.actor)
    with pytest.raises(AgentIdentityPermissionError): await f.identity.get(f.actor)


async def test_channel_owner_revocation_and_account_changes_take_effect_on_next_call(owner_channel):
    f = owner_channel
    before = f.path.read_bytes()
    config = copy.deepcopy(f.agent.config)
    for revoke in ('sender', 'account', 'proof'):
        f.agent.config = copy.deepcopy(config)
        if revoke == 'sender': f.agent.config['channels'][f.provider]['allowed_users'] = []
        elif revoke == 'account':
            channel = f.agent.config['channels'][f.provider]
            if f.provider == 'telegram': channel['token'] = '999999:another-bot'
            elif f.provider == 'whatsapp': channel['green_api_id'] = '999999'
            else: channel['identity']['account_id'] = 'another-account'
        elif f.bridge is not None: f.bridge._should_stop = True
        else: f.revoked.add(f.actor.handle)
        # Provider allowlists use [] as allow-all; mapped owners are revoked by
        # removing the binding, not by treating that list as an owner grant.
        if revoke == 'sender' and f.provider in ('slack', 'discord'):
            f.agent.config['channels'][f.provider]['identity']['user_bindings'] = {}
        with execution_scope(f.service.runtime, f.context, 'seed'):
            with pytest.raises(AgentIdentityPermissionError):
                await f.identity.update(f.actor, system_prompt='Revoked')
        assert f.path.read_bytes() == before


async def test_owner_device_rest_stays_available_without_promoting_bridge_credentials(owner_channel):
    f = owner_channel
    class Request(dict): pass
    cert = SimpleNamespace(network_id='network', handle='alice', device_pubkey_hex='owner-device', capabilities=())
    req = Request(device_cert=cert, network_id='network', user_handle='alice', client_id='owner-device',
                  auth_kind='device_cert', device_auth_epoch=1)
    req.app = {'gateway': f.gateway}
    owner = await f.service.authorizer.bind_request(req)
    assert (await f.identity.get(owner))['name'] == 'Friday'
    with pytest.raises(AgentIdentityPermissionError):
        await f.identity.get(replace(owner, device_id='unverified-device'))
    f.revoked.add('alice')
    with pytest.raises(AgentIdentityPermissionError): await f.identity.get(owner)
