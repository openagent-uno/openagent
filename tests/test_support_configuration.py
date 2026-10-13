"""Host configuration controls callback admission before any plugin IO."""
import asyncio
from types import SimpleNamespace
import unittest

from openagent_support.configuration import (
    SupportAuthorizationError, SupportConfiguration, SupportConfigurationError,
    SupportIdentity, SupportProfile,
)
from openagent_support.extensions import support_extensions


ALPHA = SupportIdentity('host-alpha', 'tenant-alpha', 'profile-alpha')
BETA = SupportIdentity('host-beta', 'tenant-beta', 'profile-beta')


def profile(identity, *, operations=('event', 'quality_scorer', 'quality_digest'), slug='support-event'):
    return SupportProfile(identity, (slug,), operations,
        {'read': identity.tenant_id + '/read'}, {'refunds': {'enabled': False}}, {'display': identity.profile_id})


class Adapter:
    def __init__(self):
        self.calls = []

    async def handle_event(self, **context):
        await asyncio.sleep(0)
        self.calls.append(context)
        return {'tenant': context['profile'].identity.tenant_id, 'target': context['profile'].tool_bindings['read']}

    async def handle_scheduled(self, **context):
        await asyncio.sleep(0)
        self.calls.append(context)
        return {'tenant': context['identity'].tenant_id, 'operation': context['operation'], 'dry_run': context['dry_run']}


class SupportConfigurationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.adapter = Adapter()
        self.configuration = SupportConfiguration((profile(ALPHA), profile(BETA)))
        self.identities = {'alpha': ALPHA, 'beta': BETA}

        async def authenticated_resolver(*, kind, agent, definition, session_id):
            # Models a host-authenticated grant, deliberately independent of payload/task name.
            return self.identities[agent.authenticated_grant]

        self.resolver = authenticated_resolver
        self.extensions = support_extensions(configuration=self.configuration,
            identity_resolver=self.resolver, adapter=self.adapter)

    async def event(self, agent='alpha', event=None, payload=None):
        return await self.extensions.event_handler(agent=SimpleNamespace(authenticated_grant=agent),
            event=event or {'slug': 'support-event'}, payload=payload or {},
            session_id='session', delivery_id='delivery')

    async def task(self, agent='alpha', task=None, prompt='[[quality-scorer]]', dry_run=True):
        return await self.extensions.scheduled_handler(agent=SimpleNamespace(authenticated_grant=agent),
            task=task or {'id': 'task'}, prompt=prompt, session_id='session', dry_run=dry_run)

    def test_unconfigured_disabled_and_partial_rejected(self):
        empty = support_extensions()
        self.assertIsNone(empty.event_handler)
        self.assertIsNone(empty.scheduled_handler)
        for arguments in ({'configuration': self.configuration}, {'identity_resolver': self.resolver},
                          {'adapter': self.adapter}):
            with self.assertRaises(SupportConfigurationError):
                support_extensions(**arguments)

    async def test_configured_operations_keep_exact_host_target(self):
        self.assertEqual(await self.event(), {'tenant': ALPHA.tenant_id, 'target': ALPHA.tenant_id + '/read'})
        self.assertEqual((await self.task(agent='beta'))['tenant'], BETA.tenant_id)
        self.assertTrue(self.adapter.calls[-1]['dry_run'])

    async def test_unknown_identity_has_no_fallback_and_no_io(self):
        self.identities['unknown'] = SupportIdentity('host-unknown', 'tenant-unknown', 'profile-unknown')
        with self.assertRaises(SupportAuthorizationError):
            await self.event(agent='unknown')
        self.assertEqual(self.adapter.calls, [])

    async def test_same_profile_name_in_wrong_tenant_or_authority_is_denied(self):
        for wrong in (SupportIdentity(ALPHA.authority_id, BETA.tenant_id, ALPHA.profile_id),
                      SupportIdentity(BETA.authority_id, ALPHA.tenant_id, ALPHA.profile_id)):
            self.identities['wrong'] = wrong
            with self.assertRaises(SupportAuthorizationError):
                await self.event(agent='wrong')
        self.assertEqual(self.adapter.calls, [])

    async def test_untyped_resolver_result_is_not_authentication(self):
        self.identities['wrong'] = {'authority_id': ALPHA.authority_id, 'tenant_id': ALPHA.tenant_id,
                                    'profile_id': ALPHA.profile_id}
        with self.assertRaises(SupportAuthorizationError):
            await self.event(agent='wrong')
        self.assertEqual(self.adapter.calls, [])

    async def test_payload_or_definition_cannot_switch_target(self):
        for key, wrong in (('supportTenant', BETA.tenant_id), ('supportProfile', BETA.profile_id),
                           ('supportAuthority', BETA.authority_id)):
            with self.assertRaises(SupportAuthorizationError):
                await self.event(payload={key: wrong})
            with self.assertRaises(SupportAuthorizationError):
                await self.task(task={'id': 'task', key: wrong})
        self.assertEqual(self.adapter.calls, [])

    async def test_task_name_cannot_choose_tenant(self):
        result = await self.task(task={'id': 'task', 'name': 'tenant-beta quality'})
        self.assertEqual(result['tenant'], ALPHA.tenant_id)

    async def test_operation_and_event_grants_are_profile_bound(self):
        self.extensions = support_extensions(configuration=SupportConfiguration((
            profile(ALPHA, operations=('quality_digest',), slug='alpha-event'), profile(BETA))),
            identity_resolver=self.resolver, adapter=self.adapter)
        with self.assertRaises(SupportAuthorizationError):
            await self.event()
        with self.assertRaises(SupportAuthorizationError):
            await self.task()
        self.assertEqual(self.adapter.calls, [])
        self.assertEqual((await self.task(prompt='[[quality-digest]]'))['operation'], 'quality_digest')

    async def test_unrelated_operations_are_left_to_core(self):
        self.assertIsNone(await self.event(event={'slug': 'unrelated'}))
        self.assertIsNone(await self.task(prompt='ordinary scheduled work'))
        self.assertEqual(self.adapter.calls, [])

    async def test_ambiguous_operation_rejected_before_io(self):
        with self.assertRaises(SupportConfigurationError):
            await self.task(prompt='[[quality-digest]][[quality-scorer]]')
        self.assertEqual(self.adapter.calls, [])

    async def test_concurrent_tenants_never_share_mutable_route(self):
        results = await asyncio.gather(*(self.event(agent=name) for name in ('alpha', 'beta') * 10))
        self.assertEqual([r['tenant'] for r in results], [ALPHA.tenant_id, BETA.tenant_id] * 10)
        for call in self.adapter.calls:
            self.assertEqual(call['profile'].identity, call['identity'])

    async def test_original_adapter_failure_is_preserved(self):
        async def fail(**context):
            raise RuntimeError('host IO failed')
        self.adapter.handle_event = fail
        with self.assertRaisesRegex(RuntimeError, 'host IO failed'):
            await self.event()

    def test_configuration_is_snapshot_not_mutable_request_state(self):
        options = {'nested': {'targets': ['alpha']}}
        configured = SupportProfile(ALPHA, options=options)
        options['nested']['targets'].append('beta')
        self.assertEqual(configured.options['nested']['targets'], ('alpha',))
        with self.assertRaises(TypeError):
            configured.options['nested']['targets'] = ()
        with self.assertRaises(SupportConfigurationError):
            SupportConfiguration((configured, configured))
        with self.assertRaises(SupportConfigurationError):
            SupportProfile(ALPHA, operations=('unknown',))
        with self.assertRaises(SupportConfigurationError):
            SupportIdentity('', ALPHA.tenant_id, ALPHA.profile_id)

    async def test_host_hooks_are_explicit_and_passed_unchanged(self):
        retainer = lambda text, limit: text[:limit]
        async def selector(*args):
            return False
        configured = support_extensions(configuration=self.configuration, identity_resolver=self.resolver,
            adapter=self.adapter, output_retainer=retainer, execution_profile_selector=selector)
        self.assertIs(configured.output_retainer, retainer)
        self.assertIs(configured.execution_profile_selector, selector)


class ReceiptTests(unittest.TestCase):
    def test_generic_receipt_retains_delivery_result_as_valid_json(self):
        import json
        from openagent_support.support_delivery_receipts import retain_event_output
        text = json.dumps({'controller': 'support-local-v1', 'reply': 'x' * 6000,
                           'actions': [{'kind': 'customer_reply', 'success': True, 'receipt': {'sent': True}}]})
        result = json.loads(retain_event_output(text, 900))
        self.assertTrue(result['detail_omitted'])
        self.assertEqual(result['delivery']['state'], 'sent')
        self.assertLessEqual(len(json.dumps(result, separators=(',', ':'))), 900)

    def test_host_controller_ids_are_explicit_not_inferred(self):
        import json
        from openagent_support.support_delivery_receipts import retain_event_output
        text = json.dumps({'controller': 'host-alpha-receipt', 'reply': 'x' * 6000})
        with self.assertRaises(ValueError):
            json.loads(retain_event_output(text, 900))
        result = json.loads(retain_event_output(text, 900, controller_ids=('host-alpha-receipt',)))
        self.assertEqual(result['controller'], 'host-alpha-receipt')
        self.assertTrue(result['detail_omitted'])


if __name__ == '__main__':
    unittest.main()
