"""Finish one miscounted catalog fixture without rebuilding qualified wheels.

The previous normal installed proof is retained unchanged. This supplemental
receipt attests only the remaining public runner/catalog gate, using an isolated
dependency fixture; it does not pretend to rerun full installed acceptance.
"""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import zipfile

from qualify_privacy_source import checked_download, command, environment_python, SDK_BASE, BASES, PROTOCOL_SHA

ARCHIVE_SHA = '20449cb4488a170ebf8593ad47b0934606007ede27e389bcff8233b08fd249eb'
SDK_WHEEL = 'openagent_connectors-0.1.3-py3-none-any.whl'
SDK_SHA = '5f8c42b4cd9d40bf8c5ffd4927d971f3c38ed262ce1583a6eb9474fdae02f3d3'


def finish_catalog(archive_path: Path, output: Path):
    from qualify_privacy_release import metadata, CORE_SOURCE
    if archive_path.stat().st_size != 3347522:
        raise ValueError('Reviewed installed candidate archive size mismatch')
    archive = archive_path.read_bytes()
    if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA:
        raise ValueError('Reviewed installed candidate archive digest mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        if sum(item.file_size for item in package.infolist()) > 32 << 20:
            raise ValueError('Candidate extraction exceeds bounded fixture size')
        for item in package.infolist():
            path = PurePosixPath(item.filename)
            if (path.is_absolute() or '..' in path.parts or not path.parts
                    or path.parts[0] not in {'core-assets','product-assets','evidence','source'}
                    or (item.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('Unsafe installed candidate member')
        package.extractall(output)
    evidence = output/'evidence'
    original = evidence/'qualification.json'
    parent_bytes = original.read_bytes()
    parent = json.loads(parent_bytes)
    expected = ['reviewed-source-unit-proof-pass',
        'clean-source-23-core-8-product-plus-exact-canonical-host-b6-wheels-pass',
        'normal-installed-pipcheck-import-prefix-core-and-product-fixtures-pass']
    if (parent['status'] != 'failed' or parent['reason'] != 'CalledProcessError'
            or parent['core_source'] != CORE_SOURCE or parent['stages'] != expected
            or parent['product_source'] != os.environ['QUALIFICATION_PRODUCT_SOURCE']):
        raise ValueError('Prior proof is not the reviewed completed installed gate')
    for family, source, count in (('core',CORE_SOURCE,23),('product',parent['product_source'],9)):
        assets = output/(family+'-assets')
        manifest = json.loads((assets/'manifest.json').read_text())
        if manifest['repository_commit'] != source or manifest['dirty_snapshot'] or len(manifest['wheels']) != count:
            raise ValueError('Prior candidate source/family count mismatch')
        for spec in manifest['wheels']:
            if metadata(assets/spec['file']) != spec:
                raise ValueError('Prior candidate bytes/metadata mismatch')
    receipt = {'format':1, 'status':'started', 'scope':'catalog-only-supplement-to-normal-installed-proof',
        'core_source':CORE_SOURCE, 'product_source':parent['product_source'],
        'prior_run_id':38470995390, 'prior_artifact_id':11851469142,
        'prior_artifact_sha256':ARCHIVE_SHA, 'prior_receipt_sha256':hashlib.sha256(parent_bytes).hexdigest(),
        'prior_status':'failed', 'prior_failure':'Fixture counted 12 official connectors without the custom MCP entry',
        'prior_installed_stages':expected, 'host_tools_proof':parent['host_tools_proof'],
        'source_tests_rerun':False, 'full_installed_tests_rerun':False, 'wheels_rebuilt':False,
        'provider_activation':False, 'real_provider_acceptance':False}
    supplemental = evidence/'qualification-supplement.json'
    def save(): supplemental.write_text(json.dumps(receipt,indent=2)+'\n')
    save()
    try:
        sdk = output/SDK_WHEEL
        checked_download(SDK_BASE,SDK_WHEEL,SDK_SHA,sdk,8726)
        protocol = output/'openagent_tool_protocol-1.0.0b1-py3-none-any.whl'
        checked_download(BASES['tools'][0],protocol.name,PROTOCOL_SHA,protocol,8323)
        fixture_python = environment_python(output/'catalog-fixture')
        command([fixture_python,'-m','pip','install','--no-deps',
            output/'product-assets/openagent_framework-1.1.0b39-py3-none-any.whl',sdk,protocol],
            output=evidence/'catalog-fixture-install.log')
        # Only stdlib-based acquisition and runner APIs run in this fixture;
        # full dependency closure/pipcheck belongs to the retained prior proof.
        probe = output/'catalog_probe.py'
        probe.write_text('''import asyncio,importlib.resources,json,pathlib,sys\nfrom openagent_server.connector_acquisition import acquire,verify_bundle\nfrom openagent_connectors import ConnectorRunner\nimport openagent_server,openagent_connectors\nfor module in (openagent_server,openagent_connectors):assert pathlib.Path(sys.prefix).resolve() in pathlib.Path(module.__file__).resolve().parents\nasync def main():\n root=pathlib.Path(sys.argv[1]);lock=pathlib.Path(str(importlib.resources.files("openagent_server").joinpath("connectors.lock.json")))\n bundle=acquire(lock,"linux-x64",root/"runner",root/"acquired-wheels");meta=json.loads(lock.read_text());verify_bundle(meta,"linux-x64",bundle)\n runner=ConnectorRunner(str(bundle/"bin/openagent-connector-runner"),identity_file=root/"fixture-identity.json",product="generic-host",name="Fixture host")\n try:\n  items=await runner.call("catalog"); official=[item for item in items if not item.get("nativeKind")];custom=[item for item in items if item.get("nativeKind")]\n  assert len(official)==12 and len(items)==13\n  assert [(item["id"],item["nativeKind"]) for item in custom]==[("custom-mcp","custom_mcp")]\n  print(json.dumps({"official_catalog_count":12,"custom_catalog_count":1,"provider_calls":0,"source_commit":meta["source_commit"],"platform":"linux-x64","imports_from_installed_prefix":True}))\n finally:await runner.close()\nasyncio.run(main())\n''')
        environment = dict(os.environ); environment.pop('PYTHONPATH',None)
        command([fixture_python,'-I',probe,output],environment=environment,
            output=evidence/'catalog-followup.log')
        receipt['status']='passed'
    except BaseException as error:
        receipt['status']='failed'
        receipt['reason']=type(error).__name__
        raise
    finally:
        save()
    # Preserve the failed original proof verbatim alongside its supplement.
    for family in ('core','product'):
        assets=output/(family+'-assets')
        shutil.copyfile(original,assets/'qualification-prior.json')
        shutil.copyfile(supplemental,assets/'qualification-supplement.json')
        manifest_path=assets/'manifest.json';manifest=json.loads(manifest_path.read_text())
        manifest['qualification']={'file':'qualification-supplement.json',
            'sha256':hashlib.sha256(supplemental.read_bytes()).hexdigest(),'scope':receipt['scope'],
            'prior_file':'qualification-prior.json','prior_sha256':receipt['prior_receipt_sha256']}
        manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
        (assets/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
            for path in sorted(assets.iterdir()) if path.is_file() and path.name!='SHA256SUMS'))
