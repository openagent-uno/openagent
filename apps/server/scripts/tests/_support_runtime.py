"""Real public runtime/catalog around deterministic product support doubles."""
from types import SimpleNamespace

from openagent_core.capabilities import ToolDefinition
from openagent_core.runtime import current_runtime


class FunctionSource:
    def __init__(self, toolkit):
        self.toolkit = toolkit

    async def discover(self, context):
        return tuple(ToolDefinition(name, name, function.parameters) for name, function in self.toolkit.functions.items())

    async def call_tool(self, name, arguments, context):
        return await self.toolkit.functions[name].entrypoint(**arguments)


def bind_pool(pool):
    runtime = current_runtime()
    if runtime is None:
        raise RuntimeError('Support doubles require verify_support.py public runtime harness')
    executor = runtime.services.executor
    for source_id in executor.sources:
        runtime.capabilities.revoke(source_id)
    executor.sources = list(pool._toolkit_by_name)
    executor.agent.capability_pool = pool
    for source_id, toolkit in pool._toolkit_by_name.items():
        source = FunctionSource(toolkit)
        runtime.capabilities.register(source_id, source, source, target_label='Deterministic support fixture')
