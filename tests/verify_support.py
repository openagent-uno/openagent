"""Run preserved support regressions without user configuration or external APIs."""
from __future__ import annotations
import asyncio
import importlib
import importlib.metadata
import json
import hashlib
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import traceback

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'apps/server'))  # test helpers only; package code must be installed
from scripts.tests._framework import TESTS, TestContext, run_one
from openagent_core import Runtime, RuntimeServices, RuntimeSettings, PrincipalRef, ExecutionContext
from openagent_core.contracts import RunRequest
from openagent_storage_sqlite import SqliteRuntimeStore
from scripts.tests._support_runtime import prepare_support_sources

MODULES=('local_support_controller','support_turn','support_context','support_diagnostic_routing','support_sept6','support_progress','support_voice','support_sept7','support_attachments')

class Authorizer:
    async def authorize(self, context, action, resource, *, audience=()):
        return context.authority.authority=='support-fixture' and resource.tenant_id=='test'

class Executor:
    def __init__(self, callback):
        self.callback=callback
        self.agent=SimpleNamespace(capability_pool=None)
        self.sources=[]
        self.failure=None
    async def execute(self, request, context, runtime):
        try:
            await self.callback()
        except BaseException as error:
            self.failure=error
            raise
        return 'support regression passed'

async def main():
    package=importlib.import_module('openagent_support')
    package_path=Path(package.__file__).resolve()
    if 'site-packages' not in package_path.parts:raise RuntimeError('Install the support wheel before qualification')
    for module in MODULES:importlib.import_module('scripts.tests.test_'+module)
    failures=[]
    observed=[]
    baseline=json.loads((ROOT/"tests/support-baseline.json").read_text())
    expected={(entry["category"],entry["name"]):entry["message_sha256"] for entry in baseline["failures"]}
    with tempfile.TemporaryDirectory(prefix='openagent-product-support-') as directory:
        root=Path(directory)
        for index,(category,name,fn) in enumerate(TESTS):
            work=root/str(index);work.mkdir()
            ctx=TestContext(work,{},work/'config.yaml',work/'state.db')
            async def invoke():await fn(ctx)
            executor=Executor(invoke)
            runtime=Runtime(RuntimeSettings('support-test',work),RuntimeServices(SqliteRuntimeStore(work/'runtime.db'),executor,Authorizer()))
            principal=PrincipalRef('support-fixture','test','tester','user')
            context=ExecutionContext(principal,principal,principal,'test-session','support-test',(principal,))
            async def check(_):
                await runtime.start()
                prepare_support_sources(runtime)
                await runtime.submit(RunRequest(run_id=f'test-{index}',idempotency_key=f'test-{index}',session_id='test-session',input=name),context)
                record=await runtime.wait(f'test-{index}',context)
                if executor.failure:raise executor.failure
                assert record.status=='success',record
            try:
                result=await run_one(category,name,check,ctx,45)
                print(f'{result.status.upper()} {category}: {name} {result.message}',flush=True)
                digest=hashlib.sha256(result.message.encode()).hexdigest()
                known=result.status=='fail' and expected.get((category,name))==digest
                observed.append({'category':category,'name':name,'status':result.status,'known_baseline_failure':known,'message_sha256':digest})
                if result.status!='ok' and not known:failures.append(result)
            finally:await runtime.close()
    receipt={'package_version':importlib.metadata.version('openagent-support-integration'),'package_file':str(package_path),'wheel_source':json.loads(importlib.metadata.distribution('openagent-support-integration').read_text('direct_url.json') or '{}'),'source_baseline':baseline['source_commit'],'tests':len(TESTS),'passed':sum(x['status']=='ok' for x in observed),'known_baseline_failures':sum(x['known_baseline_failure'] for x in observed),'new_failures':len(failures),'results':observed}
    output=ROOT/'artifacts/support-regression-verification.json';output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({key:value for key,value in receipt.items() if key!='results'}),flush=True)
    return bool(failures)

if __name__=='__main__':raise SystemExit(asyncio.run(main()))
