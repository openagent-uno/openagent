"""Product vault policies wrap the real reusable vault implementation."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from openagent_core import Runtime, RuntimeServices, RuntimeSettings
from openagent_core.core.on_behalf_context import OnBehalfIdentity
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.gateway.api import vault


class Request(dict):
    def __init__(self, gateway, subject='alice', path=None, body=None, query=None):
        super().__init__(device_cert=object(), auth_kind='device_cert')
        self.app = {'gateway': gateway}
        self.subject = subject
        self.match_info = {'path': path} if path else {}
        self.query = query or {}
        self.body = body or {}

    async def json(self):
        return self.body


class VaultAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.active = True

        async def active(*args): return self.active
        async def owner(): return 'alice'
        async def bind(request):
            return OnBehalfIdentity('network', 'user', request.subject, 'ab' * 32, 'device_cert')

        self.runtime = Runtime(RuntimeSettings('worker', self.root,
            environment=(('OPENAGENT_VAULT_VALIDATE_ON_WRITE', 'false'),)),
            RuntimeServices(SqliteRuntimeStore(self.root / 'state.db'), SimpleNamespace(execute=AsyncMock()), SimpleNamespace(authorize=active)))
        await self.runtime.start()
        self.gateway = SimpleNamespace(vault_path=str(self.root / 'vault'),
            _request_device_still_authorized=active, clients={}, _chat_client_requests={},
            _safe_ws_send_json=AsyncMock())
        self.gateway.runtime_service = SimpleNamespace(gateway=self.gateway,
            runtime=self.runtime, agent=SimpleNamespace(name='worker', config={}),
            authorizer=SimpleNamespace(bind_request=bind),
            directory=SimpleNamespace(principal_active=active, owner_handle=owner))

    async def asyncTearDown(self):
        await self.runtime.close()
        self.temp.cleanup()

    async def test_real_write_read_and_private_read_policy(self):
        write = await vault.handle_write(Request(self.gateway, path='note.md', body={'content': '# Private note\n'}))
        self.assertEqual(write.status, 200, write.text)
        self.assertTrue(json.loads(write.text)['commit'])
        read = await vault.handle_read(Request(self.gateway, path='note.md'))
        self.assertEqual(json.loads(read.text)['content'], '# Private note\n')
        denied = await vault.handle_list(Request(self.gateway, subject='bob'))
        self.assertEqual(denied.status, 403)
        self.gateway.runtime_service.agent.config['runtime_tool_audiences'] = {'vault': 'installation'}
        shared = await vault.handle_list(Request(self.gateway, subject='bob'))
        self.assertEqual(shared.status, 200)
        denied_write = await vault.handle_write(Request(self.gateway, subject='bob', path='other.md', body={'content': 'bad'}))
        self.assertEqual(denied_write.status, 403)

    async def test_service_failure_never_performs_raw_write(self):
        with patch.object(vault.VaultAdministration, 'execute', AsyncMock(side_effect=RuntimeError('quality service fault'))):
            with self.assertRaisesRegex(RuntimeError, 'quality service fault'):
                await vault.handle_write(Request(self.gateway, path='lost.md', body={'content': 'must not write'}))
        self.assertFalse((self.root / 'vault/lost.md').exists())

    async def test_resource_notifications_are_scoped_and_recheck_revocation(self):
        sockets = {name: SimpleNamespace(closed=False) for name in ('alice', 'bob')}
        self.gateway.clients.update(sockets)
        self.gateway._chat_client_requests.update({name: Request(self.gateway, subject=name) for name in sockets})
        await vault.broadcast_change(self.gateway, 'created', 'private-note.md')
        self.gateway._safe_ws_send_json.assert_awaited_once_with(sockets['alice'], {'type':'resource_event', 'resource':'vault', 'action':'created', 'id':'private-note.md'})
        self.active = False
        await vault.broadcast_change(self.gateway, 'changed')
        self.assertEqual(self.gateway._safe_ws_send_json.await_count, 1)

    async def test_invalid_paths_and_revoked_access_do_not_expose_data(self):
        invalid = await vault.handle_read(Request(self.gateway, path='../outside.md'))
        self.assertEqual(invalid.status, 400)
        self.active = False
        revoked = await vault.handle_stats(Request(self.gateway))
        self.assertEqual(revoked.status, 403)
