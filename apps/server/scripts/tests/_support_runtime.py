"""Real public runtime/catalog around deterministic product support doubles."""
from types import SimpleNamespace
from functools import wraps
import os
from pathlib import Path
import tempfile

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


def fixture_runtime(function):
    """Run a standalone replay through the same public authority as test cases.

    The temporary runtime owns only synthetic session data. Business tools must
    still be explicitly registered by ``bind_pool``; none are loaded from user
    configuration or from the registered model adapter.
    """
    @wraps(function)
    async def wrapped(*args, **kwargs):
        from openagent_core import Runtime, RuntimeServices, RuntimeSettings, PrincipalRef, ExecutionContext
        from openagent_core.contracts import RunRequest
        from openagent_storage_sqlite import SqliteRuntimeStore

        class Authorizer:
            async def authorize(self, context, action, resource, *, audience=()):
                return context.authority.authority == 'support-fixture' and resource.tenant_id == 'test'

        class Executor:
            agent = SimpleNamespace(capability_pool=None)
            sources = ()
            result = None
            failure = None

            async def execute(self, request, context, runtime):
                try:
                    self.result = await function(*args, **kwargs)
                except BaseException as error:
                    self.failure = error
                    raise
                return 'support replay completed'

        with tempfile.TemporaryDirectory(prefix='openagent-support-replay-') as directory:
            work = Path(directory)
            executor = Executor()
            runtime = Runtime(
                RuntimeSettings('support-replay', work, environment=tuple(os.environ.items())),
                RuntimeServices(SqliteRuntimeStore(work / 'runtime.db'), executor, Authorizer()),
            )
            principal = PrincipalRef('support-fixture', 'test', 'tester', 'user')
            context = ExecutionContext(principal, principal, principal, 'support-replay', 'support-replay', (principal,))
            try:
                await runtime.start()
                await runtime.submit(RunRequest(run_id='replay', idempotency_key='replay', session_id='support-replay', input=function.__name__), context)
                record = await runtime.wait('replay', context)
                if executor.failure is not None:
                    raise executor.failure
                if record.status != 'success':
                    raise RuntimeError(f'Support replay runtime ended with {record.status}')
                return executor.result
            finally:
                await runtime.close()
    return wrapped
