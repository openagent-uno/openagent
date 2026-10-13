"""Remote-only source units, preceded by normal verified public dependency installs.

No candidate release build, provider activation or installed-product acceptance.
All source paths are explicit and confined to the test subprocesses. Baseline and
SDK13 dependency environments remain separate; existing Beta38 pins are preserved.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib
import urllib.request

CORE_SOURCE = '9d9603f76999e77f13c6d7f2024aa061891dcd8f'
PRODUCT_BASE = 'be8647fa247389feeb7df3499732f49b2e020a73'
SDK_SOURCE = 'a5f81d65a0d7939473b30759276fa719272fda4a'
BASES = {
    'core': ('https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.21/',
             '28695103622403e02f06692d869f48b14bb0bbd1e32df4bb38d99e7600d60bd5',
             'cedd0607c5ea3a3df2c95e9d169f4621cac0b3ae'),
    'product': ('https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.38/',
                '901ed4286196cc882bdcde0bacdcc7b0e93535f0d9f45b6a5425ac73ff542360',
                '3788ad026a6cf3d0de2578ce2bfbfc91dc24dfb4'),
    'tools': ('https://github.com/openagent-uno/openagent-tools/releases/download/v1.0.0-beta.4/',
              '20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228', None),
}
SDK_BASE = 'https://github.com/openagent-uno/openagent-tools/releases/download/connectors-v0.1.3/'
SDK12_SHA = '48f0a5246bbcf7cacc831ed9a26c04bcb8894662d7b96e030d23c72ae9acf5b9'
PROTOCOL_SHA = '3d4c266eb8e51552408c70448ad7c466a6cb8fa7263939412ce4069c8b73cef2'


def checked_download(base, filename, digest, destination, size=None):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+', filename) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid reviewed artifact locator')
    data = urllib.request.urlopen(base + filename, timeout=60).read((64 << 20) + 1)
    if len(data) > 64 << 20 or (size is not None and len(data) != size) or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Public artifact differs from its reviewed digest/size')
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return data


def command(arguments, *, output, cwd=None, environment=None):
    with output.open('ab') as stream:
        subprocess.run([str(value) for value in arguments], cwd=cwd, env=environment,
                       stdout=stream, stderr=subprocess.STDOUT, check=True)


def environment_python(root):
    subprocess.run([sys.executable, '-m', 'venv', str(root)], check=True)
    return root/'bin/python'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--core', required=True, type=Path)
    parser.add_argument('--product', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    options = parser.parse_args()
    core, product, output = (value.resolve() for value in (options.core, options.product, options.output))
    evidence = output/'evidence'
    evidence.mkdir(parents=True, exist_ok=True)
    receipt = {'qualification':'source-unit-only', 'status':'started', 'stages':[],
               'candidate_installed_product_acceptance':False, 'provider_activation':False,
               'core_source':CORE_SOURCE, 'product_source':os.environ['QUALIFICATION_PRODUCT_SOURCE'],
               'recipe_source':subprocess.check_output(['git','rev-parse','HEAD'],
                   cwd=Path(__file__).resolve().parent.parent, text=True).strip()}
    def save():
        (evidence/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    save()
    try:
        product_source = receipt['product_source']
        if not re.fullmatch(r'[a-f0-9]{40}', product_source):
            raise ValueError('An exact reviewed product SHA is required')
        for path, expected in ((core, CORE_SOURCE), (product, product_source)):
            actual = subprocess.check_output(['git','rev-parse','HEAD'], cwd=path, text=True).strip()
            if actual != expected:
                raise ValueError('Qualification checkout is not the reviewed source')
            subprocess.run(['git','diff','--quiet','HEAD'], cwd=path, check=True)
        subprocess.run(['git','merge-base','--is-ancestor', PRODUCT_BASE, product_source], cwd=product, check=True)
        wheelhouse = output/'public-wheels'
        baseline_wheels = []
        for label, (base, digest, source) in BASES.items():
            value = json.loads(checked_download(base, 'manifest.json', digest, evidence/(label+'-manifest.json')))
            if value.get('dirty_snapshot') is not False or (source and value.get('repository_commit', value.get('source_commit')) != source):
                raise ValueError('Public baseline provenance mismatch')
            specs = value.get('wheels')
            if specs is None:
                specs = [{'file':name, **details} for name, details in value['files'].items() if name.endswith('.whl')]
            for spec in specs:
                name = spec['file']
                target = wheelhouse/name
                checked_download(base, name, spec['sha256'], target, spec.get('bytes', spec.get('size_bytes')))
                baseline_wheels.append(target)
        protocol = wheelhouse/'openagent_tool_protocol-1.0.0b1-py3-none-any.whl'
        if hashlib.sha256(protocol.read_bytes()).hexdigest() != PROTOCOL_SHA:
            raise ValueError('Public protocol closure mismatch')
        sdk12 = wheelhouse/'openagent_connectors-0.1.2-py3-none-any.whl'
        checked_download(SDK_BASE.replace('0.1.3','0.1.2'), sdk12.name, SDK12_SHA, sdk12)
        baseline_wheels.append(sdk12)
        baseline = environment_python(output/'baseline38')
        command([baseline,'-m','pip','install',*baseline_wheels,'openagent-core[engine,providers,modules]==1.1.0b21'],
                output=evidence/'baseline-install.log')
        command([baseline,'-m','pip','check'], output=evidence/'baseline-pip-check.log')
        command([baseline,'-m','pip','freeze','--all'], output=evidence/'baseline-freeze.txt')
        receipt['stages'].append('normal-public-beta38-core21-sdk12-closure-pass')
        save()
        sdk_digest = os.environ['QUALIFICATION_SDK_MANIFEST_SHA256']
        sdk_manifest = json.loads(checked_download(SDK_BASE, 'manifest.json', sdk_digest, evidence/'sdk13-manifest.json'))
        if sdk_manifest.get('source_commit') != SDK_SOURCE or sdk_manifest.get('dirty_snapshot') is not False or sdk_manifest.get('version') != '0.1.3':
            raise ValueError('SDK13 artifact source mismatch')
        name = 'openagent_connectors-0.1.3-py3-none-any.whl'
        metadata = sdk_manifest['files'][name]
        sdk13 = output/name
        checked_download(SDK_BASE, name, metadata['sha256'], sdk13, metadata['bytes'])
        unit = environment_python(output/'unit-dependencies')
        # Do not install Beta38 framework's incompatible exact SDK12 pin into
        # the independent SDK13 dependency fixture. Framework itself is tested
        # solely from the declared source unit path, not as an installed product.
        selected = [wheel for wheel in baseline_wheels if not wheel.name.startswith(('openagent_framework-', 'openagent_connectors-'))]
        third_party = [requirement for requirement in tomllib.loads((product/'apps/server/pyproject.toml').read_text())['project']['dependencies']
                       if not requirement.startswith('openagent-')]
        command([unit,'-m','pip','install',*selected,sdk13,'openagent-core[engine,providers,modules]==1.1.0b21',
                 *third_party,'pytest','pytest-asyncio'], output=evidence/'unit-install.log')
        command([unit,'-m','pip','check'], output=evidence/'unit-pip-check.log')
        command([unit,'-m','pip','freeze','--all'], output=evidence/'unit-freeze.txt')
        receipt['stages'].append('normal-public-sdk13-dependency-fixture-pass')
        save()
        environment = dict(os.environ, OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1')
        environment['PYTHONPATH'] = os.pathsep.join(str(path) for path in (core/'packages/runtime/src',core/'packages/storage-sqlite/src'))
        command([unit,'-m','unittest','discover','-s','tests/public','-q'], cwd=core, environment=environment, output=evidence/'core-source-units.log')
        receipt['stages'].append('core-source-public-units-pass')
        save()
        environment['PYTHONPATH'] += os.pathsep + os.pathsep.join(str(path) for path in (
            product/'apps/server/src', product/'packages/integrations/support/src', product/'packages/product-config/src'))
        tests = ('test_connector_privacy_bootstrap.py','test_connector_privacy_api.py','test_connector_provenance.py',
                 'test_connector_privacy.py','test_runtime_service.py','test_official_connectors.py',
                 'test_connector_privacy_receipts.py','test_support_configuration.py','test_server_host_extensions.py','test_workspace.py')
        command([unit,'-m','pytest','--asyncio-mode=auto','-q',*(str(Path('tests')/name) for name in tests)],
                cwd=product, environment=environment, output=evidence/'product-source-units.log')
        receipt['stages'].append('product-source-privacy-support-bootstrap-units-pass')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt['status'] = 'failed'
        receipt['reason'] = type(error).__name__
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
