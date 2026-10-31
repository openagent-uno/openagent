"""Real product descriptors, management schemas and instance-owned SQLite."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from openagent_core import ModuleConfig, RuntimeProfile
from openagent_core.mcp.pool import MCPPool
from openagent_module_budget import descriptor as upstream_budget
from openagent_module_models import descriptor as upstream_models
from openagent_module_skills import descriptor as upstream_skills
from openagent_product_config.modules import FULL_DESCRIPTORS


class ProductManagementStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_product_management_starts_without_stdio_and_keeps_databases_separate(self):
        descriptors = {item.id: item for item in FULL_DESCRIPTORS}
        instances = []
        connections = []
        with TemporaryDirectory() as temporary:
            paths = [Path(temporary) / (name + '.sqlite3') for name in ('first', 'second')]
            try:
                # An attempted stdio handshake is a regression, even if it
                # happens to finish before the cold-start timeout on this Mac.
                with patch.object(MCPPool, '_build_and_enter_toolkit',
                                  side_effect=AssertionError('management spawned stdio')):
                    for path in paths:
                        for name in ('budget', 'models', 'skills'):
                            context = SimpleNamespace(
                                config=ModuleConfig(frozenset({'service', 'agent_tools'}),
                                                    {'db_path': str(path)}),
                                profile=RuntimeProfile(1, {}),
                            )
                            instance = await descriptors[name].prepare(context)
                            instances.append(instance)
                            await instance.start()
                    budgets = [instance.pool.toolkit_by_name('budget-manager')
                               for instance in instances if instance.descriptor.id == 'budget']
                    result = await budgets[0].async_functions['budget_manager_set_budget'].entrypoint(
                        scope='global', amount=7.5)
                    self.assertFalse(result.mcp_result['isError'], result.mcp_result)
                    for index, expected_count in ((0, 1), (1, 0)):
                        result = await budgets[index].async_functions['budget_manager_list_budgets'].entrypoint()
                        self.assertFalse(result.mcp_result['isError'], result.mcp_result)
                        structured = result.mcp_result['structuredContent']
                        rows = structured['result'] if isinstance(structured, dict) else structured
                        self.assertEqual(len(rows), expected_count)
                        connections.append(budgets[index]._db._conn)
            finally:
                for instance in reversed(instances):
                    await instance.close()
            for connection in connections:
                with self.assertRaises(ValueError):
                    await connection.execute('SELECT 1')

        # A product transport preference must not mutate the public modules.
        for descriptor in (upstream_budget, upstream_models, upstream_skills):
            self.assertFalse(descriptor.in_process_management)
