"""Actual official source registration and public catalog IO boundary."""
from dataclasses import replace
import aiosqlite
import pytest

from openagent_core import RunRequest
from openagent_core.content_privacy import PrivacyFence
from openagent_core.runtime import execution_scope
from test_connector_privacy_api import owned_server


class ProviderFixture:
    def __init__(self):
        self.invocations = []

    async def close(self):
        pass

    async def call(self, method, params=None):
        if method == 'tools':
            return [{'name':'commerce.shopify.customers.'+name, 'description':name,
                     'inputSchema':{'type':'object'}, 'risk':'read' if name == 'get' else 'write'}
                    for name in ('get', 'update')]
        if method == 'invoke':
            self.invocations.append(params['tool'])
            if params['tool'].endswith('.get'):
                return {'data':{'data':{'customer':{'id':params['arguments']['id'],'name':'PROVIDER CUSTOMER'}}}}
            if not params['binding']['allow_write']:
                raise PermissionError('Local write grant is missing')
            return {'data':{'data':{'customerUpdate':{'customer':{
                'id':params['arguments']['input']['id'],'name':'UPDATED CUSTOMER'}, 'userErrors':[]}}}}
        raise AssertionError('No broker or provider network call is expected')


class RenewingProviderFixture(ProviderFixture):
    def __init__(self):
        super().__init__()
        self.refreshes = 0
        self.after_refresh = None

    async def call(self, method, params=None):
        if method == 'auth.refresh':
            self.refreshes += 1
            if self.after_refresh is not None:
                await self.after_refresh()
            return {'group':'group', 'recipients':[], 'token':{
                **params['token'], 'access_token':'synthetic-refreshed', 'version':2,
                'expires_at':'2099-01-01T00:00:00Z'}}
        if method == 'auth.publish':
            return {'ok':True}
        return await super().call(method, params)


@pytest.mark.asyncio
async def test_real_catalog_source_binds_read_and_same_customer_write_before_io(tmp_path):
    server = await owned_server(tmp_path/'owned', 'tenant')
    runner = ProviderFixture()
    server.service.runner = runner
    try:
        # The fixture represents an already verified recipient. Enrollment
        # remains disabled; no provider consent or live token is minted here.
        async with aiosqlite.connect(server.service.db_path) as db:
            await db.execute("UPDATE official_connector_connections SET status='pending' WHERE id='connection'")
            await db.commit()
        row = await server.service.record('connection')
        await server.service.save(row, {'access_token':'synthetic-fixture', 'app_id':'app','group':'group',
                                       'authorized_at':'2026-10-13T10:00:00Z','version':1})
        await server.service.update(server.context, 'connection', {'allow_write':True})
        context = replace(server.context, session_id='managed-session')
        await server.canonical.accept(RunRequest('managed-run', context.session_id, 'managed-key', 'READ AND UPDATE'), context)
        await server.canonical.transition('managed-run', 'running')
        tools = {item.name:item.tool_ref for item in await server.runtime.capabilities.discover(context)}
        with execution_scope(server.runtime, context, 'managed-run'):
            await server.runtime.capabilities.call_tool(tools['commerce.shopify.customers.get'],
                {'id':'gid://shopify/Customer/23'}, context)
            with pytest.raises(PrivacyFence):
                await server.runtime.capabilities.call_tool(tools['commerce.shopify.customers.update'],
                    {'input':{'id':'gid://shopify/Customer/24','firstName':'COPIED CONTEXT'}}, context)
            assert runner.invocations == ['commerce.shopify.customers.get']
            await server.runtime.capabilities.call_tool(tools['commerce.shopify.customers.update'],
                {'input':{'id':'gid://shopify/Customer/23','firstName':'UPDATED CUSTOMER'}}, context)
            origins = await server.publisher.origins_for_execution(context, 'managed-run')
        assert all(origin.group_id == 'group' and origin.source_id == 'shopify/app' for origin in origins)
        assert {subject for origin in origins for subject in origin.subjects} == {'customer:23'}
        assert runner.invocations == ['commerce.shopify.customers.get','commerce.shopify.customers.update']
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_actual_catalog_expired_token_refresh_keeps_same_consent_invocation_valid(tmp_path):
    server = await owned_server(tmp_path/'owned', 'tenant')
    runner = RenewingProviderFixture()
    server.service.runner = runner
    try:
        async with aiosqlite.connect(server.service.db_path) as db:
            await db.execute("UPDATE official_connector_connections SET status='pending' WHERE id='connection'")
            await db.commit()
        await server.service.save(await server.service.record('connection'), {
            'access_token':'synthetic-expired', 'app_id':'app','group':'group',
            'authorized_at':'2026-10-13T10:00:00Z','expires_at':'2020-01-01T00:00:00Z','version':1})
        context = replace(server.context, session_id='refresh-session')
        await server.canonical.accept(RunRequest('refresh-run', context.session_id, 'refresh-key', 'READ'), context)
        await server.canonical.transition('refresh-run', 'running')
        tools = {item.name:item.tool_ref for item in await server.runtime.capabilities.discover(context)}
        with execution_scope(server.runtime, context, 'refresh-run'):
            result = await server.runtime.capabilities.call_tool(tools['commerce.shopify.customers.get'],
                {'id':'gid://shopify/Customer/23'}, context)
        assert result['data']['customer']['id'] == 'gid://shopify/Customer/23'
        assert runner.refreshes == 1
        assert runner.invocations == ['commerce.shopify.customers.get']
        current = server.service.decrypt(await server.service.record('connection'))
        assert current['version'] == 2 and current['authorized_at'] == '2026-10-13T10:00:00Z'
    finally:
        await server.close()
