"""Remote source proof followed by normal installed Core22/product39 proof.

Builds Core's 23 wheels and eight product families from clean pinned snapshots.
The ninth product family is the exact PUBLIC canonical HostTools B6 wheel, never
a rebuilt same-version archive. This script publishes nothing and grants no OAuth.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import os
import runpy
from email.parser import BytesParser
import zipfile

from qualify_privacy_source import CORE_SOURCE, checked_download, command, environment_python

HOST_SOURCE = 'aa8dafb3ef14066dbdaadbbf66bc9b3a00b801e0'
HOST_BASE = 'https://github.com/openagent-uno/openagent/releases/download/v1.0.0b6/'
HOST_WHEEL_SHA = 'b7e127a036d0a18c1fce2f38dae5f405e68b80eb8d4ed16fd6e0758f6b272a5e'
COMPONENTS = ('server', 'cli', 'mcp-bridge', 'identity', 'dashboards',
              'integrations-support', 'product-config', 'client-transport')


def metadata(path):
    with zipfile.ZipFile(path) as archive:
        value = BytesParser().parsebytes(archive.read(next(name for name in archive.namelist()
            if name.endswith('.dist-info/METADATA'))))
    return {'file':path.name, 'name':value['Name'], 'version':value['Version'],
            'sha256':hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes':path.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('core', 'product', 'output'):
        parser.add_argument('--'+name, required=True, type=Path)
    options = parser.parse_args()
    core, product, output = (getattr(options, name).resolve() for name in ('core', 'product', 'output'))
    evidence = output/'evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    receipt = {'format':1, 'status':'started', 'scope':'source-and-installed-python-fixtures',
        'core_source':CORE_SOURCE, 'product_source':os.environ['QUALIFICATION_PRODUCT_SOURCE'],
        'provider_activation':False, 'real_provider_acceptance':False, 'stages':[],
        'recipe_source':subprocess.check_output(['git','rev-parse','HEAD'],
            cwd=Path(__file__).resolve().parent.parent, text=True).strip()}
    def save():
        (evidence/'qualification.json').write_text(json.dumps(receipt, indent=2)+'\n')
    save()
    try:
        command([sys.executable, Path(__file__).with_name('qualify_privacy_source.py'),
                 '--core',core,'--product',product,'--output',output/'source'], output=evidence/'source-stage.log')
        receipt['stages'].append('reviewed-source-unit-proof-pass')
        save()
        index = json.loads(checked_download(HOST_BASE,'release-index.json',
            os.environ['QUALIFICATION_HOST_INDEX_SHA256'],evidence/'host-b6-index.json'))
        if (index.get('source_commit') != HOST_SOURCE or index.get('version') != '1.0.0b6'
                or index.get('source_repository') != 'openagent-uno/openagent'
                or len(index.get('platforms',{})) != 6):
            raise ValueError('HostTools public canonical index identity mismatch')
        core_assets, product_assets = output/'core-assets', output/'product-assets'
        command([sys.executable,core/'packaging/build.py','--out',core_assets],output=evidence/'build-core.log',cwd=core)
        command([sys.executable,product/'scripts/build_wheels.py','--out',product_assets,
                 '--components',*COMPONENTS],output=evidence/'build-product.log',cwd=product)
        host = index['python_wheel']
        if host['asset'] != 'openagent_host_tools-1.0.0b6-py3-none-any.whl' or host['sha256'] != HOST_WHEEL_SHA:
            raise ValueError('Unexpected canonical HostTools Python payload')
        checked_download(HOST_BASE,host['asset'],host['sha256'],product_assets/host['asset'],47103)
        runpy.run_path(str(product/'scripts/build_wheels.py'))['verify_ownership'](sorted(product_assets.glob('*.whl')))
        manifest = json.loads((product_assets/'manifest.json').read_text())
        manifest['wheels'].append(metadata(product_assets/host['asset']))
        manifest['upstream_components'] = {'host-tools':{
            'source_repository':'openagent-uno/openagent', 'source_commit':HOST_SOURCE,
            'release':HOST_BASE, 'index_sha256':os.environ['QUALIFICATION_HOST_INDEX_SHA256'],
            **manifest['wheels'][-1]}}
        (product_assets/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        for assets, source, count in ((core_assets,CORE_SOURCE,23),
                                     (product_assets,receipt['product_source'],9)):
            item = json.loads((assets/'manifest.json').read_text())
            if item['repository_commit'] != source or item['dirty_snapshot'] or len(item['wheels']) != count:
                raise ValueError('Candidate source/cleanliness/family count mismatch')
            for spec in item['wheels']:
                if metadata(assets/spec['file']) != spec:
                    raise ValueError('Candidate wheel differs from manifest bytes/metadata')
        receipt['stages'].append('clean-source-23-core-8-product-plus-exact-public-host-b6-wheels-pass')
        save()
        installed = environment_python(output/'installed')
        public = output/'source/public-wheels'
        tools_manifest = json.loads((output/'source/evidence/tools-manifest.json').read_text())
        tools = [public/name for name in tools_manifest['files'] if name.endswith('.whl')]
        payloads = [*core_assets.glob('*.whl'),*product_assets.glob('*.whl'),*tools,
                    output/'source/openagent_connectors-0.1.3-py3-none-any.whl']
        command([installed,'-m','pip','install',*payloads,'openagent-core[engine,providers,modules]==1.1.0b22',
                 'PyJWT==2.14.0','urllib3==2.8.0','pytest','pytest-asyncio'],output=evidence/'installed-install.log')
        command([installed,'-m','pip','check'],output=evidence/'installed-pip-check.log')
        command([installed,'-m','pip','freeze','--all'],output=evidence/'installed-freeze.txt')
        fixture = output/'installed-fixtures'
        fixture.mkdir()
        # Copy only tests, never any first-party implementation/source package.
        core_tests = fixture/'core'; core_tests.mkdir()
        for path in (core/'tests/public').glob('test_*.py'):
            if 'privacy' in path.name or path.name == 'test_provider_tool_provenance.py':
                shutil.copyfile(path,core_tests/path.name)
        product_tests = fixture/'product'; product_tests.mkdir()
        names = ('test_connector_privacy_bootstrap.py','test_connector_privacy_api.py','test_connector_provenance.py',
                 'test_connector_privacy.py','test_official_connectors.py','test_connector_privacy_receipts.py',
                 'test_support_configuration.py','test_server_host_extensions.py','test_runtime_service.py','test_runtime_access.py')
        for name in names:
            shutil.copyfile(product/'tests'/name,product_tests/name)
        verification = fixture/'verify_install.py'
        verification.write_text('''import importlib,importlib.metadata,json,sys,pathlib\nfrom openagent_core import __version__\nassert __version__ == "1.1.0b22"\nmodules=["openagent_core","openagent_storage_sqlite","openagent_server","openagent_identity",\n"openagent_client_transport","openagent_connectors","openagent_support","openagent_product_config", "openagent_host_tools"]\nfor name in modules:\n m=importlib.import_module(name);p=pathlib.Path(m.__file__).resolve()\n assert pathlib.Path(sys.prefix).resolve() in p.parents,(name,str(p))\nassert importlib.metadata.version("openagent-framework")=="1.1.0b39"\nassert importlib.metadata.version("openagent-host-tools")=="1.0.0b6"\nfor entry in importlib.metadata.entry_points(group="openagent.modules"):entry.load()\nprint(json.dumps({"core":__version__,"product":"1.1.0b39","imports_from_installed_prefix":True,"module_entrypoints":len(importlib.metadata.entry_points(group="openagent.modules"))}))\n''')
        command([installed,'-I',verification],cwd=fixture,output=evidence/'installed-imports.log')
        environment = dict(os.environ)
        environment.pop('PYTHONPATH',None)
        command([installed,'-I','-m','unittest','discover','-s',core_tests,'-q'],
                cwd=fixture,environment=environment,output=evidence/'installed-core-tests.log')
        command([installed,'-I','-m','pytest','--asyncio-mode=auto','-q',product_tests],
                cwd=fixture,environment=environment,output=evidence/'installed-product-tests.log')
        receipt['stages'].append('normal-installed-pipcheck-import-prefix-core-and-product-fixtures-pass')
        save()
        runner_check = fixture/'runner_check.py'
        runner_check.write_text('''import asyncio,json,pathlib,sys\nfrom openagent_server.connector_acquisition import acquire,verify_bundle\nfrom openagent_connectors import ConnectorRunner\nasync def main():\n root=pathlib.Path(sys.argv[2]); lock=pathlib.Path(sys.argv[1]); wheelhouse=root/"acquired-wheels"\n bundle=acquire(lock,"linux-x64",root/"runner",wheelhouse)\n metadata=json.loads(lock.read_text());verify_bundle(metadata,"linux-x64",bundle)\n runner=ConnectorRunner(str(bundle/"bin/openagent-connector-runner"),identity_file=root/"fixture-identity.json",product="generic-host",name="Fixture host")\n try:\n  items=await runner.call("catalog"); assert len(items)==12\n  print(json.dumps({"catalog_count":len(items),"provider_calls":0,"source_commit":metadata["source_commit"],"platform":"linux-x64"}))\n finally: await runner.close()\nasyncio.run(main())\n''')
        command([installed,'-I',runner_check,product/'apps/server/connectors.lock.json',output],
                cwd=fixture,environment=environment,output=evidence/'installed-runner-catalog.log')
        receipt['stages'].append('actual-installed-acquirer-public-runner-catalog-12-without-provider-io-pass')
        receipt['status']='passed'
        save()
        for assets in (core_assets,product_assets):
            manifest = json.loads((assets/'manifest.json').read_text())
            qualification_sha = hashlib.sha256((evidence/'qualification.json').read_bytes()).hexdigest()
            manifest['qualification']={'scope':receipt['scope'],'status':'passed','file':'qualification.json',
                                       'sha256':qualification_sha}
            shutil.copyfile(evidence/'qualification.json',assets/'qualification.json')
            (assets/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
            checks = ''.join(hashlib.sha256(path.read_bytes()).hexdigest()+'  '+path.name+'\n'
                             for path in sorted(assets.iterdir()) if path.is_file() and path.name!='SHA256SUMS')
            (assets/'SHA256SUMS').write_text(checks)
    except BaseException as error:
        receipt['status']='failed'
        receipt['reason']=type(error).__name__
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
