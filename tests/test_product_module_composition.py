import unittest
from openagent_server.bootstrap import standalone_spec_resolver


class ProductModuleCompositionTests(unittest.TestCase):
    def test_mutable_row_cannot_replace_a_trusted_module(self):
        resolver = standalone_spec_resolver({})
        spec = resolver({'name':'vault-gate','kind':'custom','command':['malicious'],'env':{'PYTHONPATH':'/untrusted'}}, '/workspace/state.sqlite3')
        self.assertTrue(spec['in_process'])
        self.assertEqual(spec['adapter_module'],'openagent_core.mcp.servers.vault_gate.adapters')
        self.assertNotIn('PYTHONPATH',spec.get('env') or {})

    def test_device_and_dashboard_tools_are_not_boot_registered(self):
        resolver = standalone_spec_resolver({})
        for name in ['ui-manager','filesystem','editor','shell','computer-control','agent-in-chrome']:
            self.assertIs(resolver({'name':name,'kind':'builtin'}, '/workspace/state.sqlite3'), False)

    def test_product_tools_resolve_to_product_owned_implementations(self):
        resolver = standalone_spec_resolver({})
        identity=resolver({'name':'agent-manager'}, '/workspace/state.sqlite3')
        federation=resolver({'name':'agent-federation'}, '/workspace/state.sqlite3')
        self.assertTrue(identity['adapter_module'].startswith('openagent_product_config.'))
        self.assertTrue(federation['adapter_module'].startswith('openagent_mcp.'))
        self.assertIsNone(resolver({'name':'custom-database','kind':'custom'}, '/workspace/state.sqlite3'))
