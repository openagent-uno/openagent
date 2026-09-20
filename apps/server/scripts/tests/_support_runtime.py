"""Real public runtime/catalog around deterministic product support doubles."""
from types import SimpleNamespace
from functools import wraps
import os
from pathlib import Path
import tempfile

from openagent_core.capabilities import ToolDefinition
from openagent_core.runtime import current_runtime


class FunctionSource:
    def __init__(self, toolkit, *, source_id=None):
        self.toolkit = toolkit
        self.source_id = source_id
        self.pool = None

    def _current_toolkit(self):
        if self.pool is not None and self.source_id is not None:
            return self.pool.toolkit_by_name(self.source_id) or _EmptyToolkit()
        return self.toolkit

    async def discover(self, context):
        return tuple(ToolDefinition(name, name, function.parameters) for name, function in self._current_toolkit().functions.items())

    async def call_tool(self, name, arguments, context):
        return await self._current_toolkit().functions[name].entrypoint(**arguments)


SUPPORT_FIXTURE_SOURCES = (
    'billingbear',
    'clickup',
    'esound-identity',
    'lyra-admin',
    'messaging',
    'replio',
    'support-evidence',
    'vault',
)


class _EmptyToolkit:
    functions = {}


def prepare_support_sources(runtime):
    """Register stable test-only destinations before a run takes its snapshot.

    Individual regressions replace only the in-memory toolkit behind each
    destination.  Registering or revoking a source from inside the run would
    correctly defer it until the next run, which is production behaviour and
    must not be weakened for a deterministic fixture.
    """
    executor = runtime.services.executor
    if getattr(executor, 'fixture_sources', None) is not None:
        return
    executor.fixture_sources = {}
    for source_id in SUPPORT_FIXTURE_SOURCES:
        source = FunctionSource(_EmptyToolkit(), source_id=source_id)
        executor.fixture_sources[source_id] = source
        runtime.capabilities.register(
            source_id,
            source,
            source,
            target_label='Deterministic support fixture',
        )


def bind_pool(pool, *, runtime=None):
    runtime = runtime or current_runtime()
    if runtime is None:
        raise RuntimeError('Support doubles require verify_support.py public runtime harness')
    executor = runtime.services.executor
    sources = getattr(executor, 'fixture_sources', None)
    if sources is None:
        raise RuntimeError('Support fixture sources must be prepared before run admission')
    executor.sources = list(pool._toolkit_by_name)
    executor.agent.capability_pool = pool
    for source in sources.values():
        source.pool = pool
    for source_id, toolkit in pool._toolkit_by_name.items():
        try:
            sources[source_id].toolkit = toolkit
        except KeyError as error:
            raise RuntimeError(
                f'Unknown support fixture destination {source_id!r}; pre-register it before run admission'
            ) from error


def fixture_runtime(function=None, *, prepare=None):
    """Run a standalone replay through the same public authority as test cases.

    The temporary runtime owns only synthetic session data. Business tools must
    still be explicitly registered by ``bind_pool``; none are loaded from user
    configuration or from the registered model adapter.
    """
    if function is None:
        return lambda decorated: fixture_runtime(decorated, prepare=prepare)

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
                prepare_support_sources(runtime)
                if prepare is not None:
                    prepare(runtime)
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
