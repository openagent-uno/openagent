"""Product vault policies wrap the real reusable vault implementation."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from openagent_core import Runtime, RuntimeServices, RuntimeSettings
from openagent_core.core.on_behalf_context import OnBehalfIdentity
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.gateway.api import vault


class NewAgentVault(unittest.TestCase):
    def test_only_clean_installations_choose_sql_automatically(self):
        import tempfile
        import yaml
        from openagent_product_config.paths import ensure_agent_dir
        from openagent_server.document_vault import uses_documents
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clean = ensure_agent_dir(root / "new")
            self.assertTrue(uses_documents(yaml.safe_load((clean / "openagent.yaml").read_text())))
            old = root / "existing"
            (old / "memories").mkdir(parents=True)
            (old / "memories/note.md").write_text("existing")
            ensure_agent_dir(old)
            self.assertFalse(uses_documents(yaml.safe_load((old / "openagent.yaml").read_text())))


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

    async def test_document_bootstrap_authenticated_history_and_restore(self):
        from openagent_core.contracts import PrincipalRef, ExecutionContext
        from openagent_server.document_vault import create_document_vault, uses_documents
        service = self.gateway.runtime_service
        service.agent.config["memory"] = {"vault":{"backend":"documents"}}
        service.agent.memory_db = SimpleNamespace(db_path=str(self.root/"state.db"))
        self.gateway.vault_path = None
        self.assertTrue(uses_documents(service.agent.config))
        async def context(identity,session):
            owner=PrincipalRef("openagent",identity.tenant_id,identity.handle,identity.principal_type)
            return ExecutionContext(owner,owner,owner,session,service.agent.name,(owner,))
        async def access(context, action, resource, **kwargs):
            return self.active and resource.resource_id=="agent-vault" and context.authority.subject_id=="alice"
        service.authorizer.context_for_identity=context
        service.authorizer.authorize=access
        service.document_vault=await create_document_vault(service)
        self.addAsyncCleanup(service.document_vault.engine.dispose)
        def req(**kwargs):return Request(self.gateway,**kwargs)
        self.assertEqual((await vault.handle_write(req(path="a.md",body={"content":"first"}))).status,200)
        history=json.loads((await vault.handle_history(req())).text)
        digest=history["commits"][0]["hash"]
        self.assertEqual(json.loads((await vault.handle_commit(req(query={"hash":digest}))).text)["files"][0]["path"],"a.md")
        self.assertEqual((await vault.handle_write(req(path="a.md",body={"content":"second","expected_revision":0}))).status,409)
        self.assertEqual((await vault.handle_write(req(path="a.md",body={"content":"second","expected_revision":1}))).status,200)
        self.assertEqual((await vault.handle_restore(req(body={"hash":digest}))).status,200)
        self.assertEqual(json.loads((await vault.handle_read(req(path="a.md"))).text)["content"],"first")
        self.assertEqual((await vault.handle_history(req(subject="bob"))).status,403)
        self.active=False
        self.assertEqual((await vault.handle_commit(req(query={"hash":digest}))).status,403)
        self.assertFalse((self.root/"vault").exists())

    def test_gateway_uses_the_agent_default_vault_without_a_yaml_override(self):
        from openagent_server import server as server_module

        expected = str((self.root / 'agent' / 'memories').resolve())
        resolver = Mock(return_value=expected)
        agent = SimpleNamespace(_resolve_vault_path=resolver)
        with patch.object(server_module, '_build_agent', return_value=agent):
            product = server_module.AgentServer.from_config({'name': 'Friday', 'memory': {}})

        self.assertEqual(product._gateway_vault_path, expected)
        resolver.assert_called_once_with()

    def test_gateway_keeps_vault_absent_from_the_minimal_local_e2e_profile(self):
        from openagent_server import server as server_module

        resolver = Mock(return_value=str((self.root / 'memories').resolve()))
        agent = SimpleNamespace(_resolve_vault_path=resolver)
        with patch.object(server_module, '_build_agent', return_value=agent):
            product = server_module.AgentServer.from_config({
                'name': 'fixture',
                'memory': {},
                '_local_e2e': True,
            })

        self.assertIsNone(product._gateway_vault_path)
        resolver.assert_not_called()
