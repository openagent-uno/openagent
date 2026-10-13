"""Execute the exact public installer candidate; no source-overlay acceptance."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

SCRIPT_SHA='ccc9e983d9df31e393fdfeaccbb37ea61977cc9fb7a7bb61953e96115527fac9'
SOURCE='45c57221d5c56927e0498e01498f3ae3eca89ab7'


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--script',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    script=args.script.resolve();root=args.output.resolve()
    if hashlib.sha256(script.read_bytes()).hexdigest()!=SCRIPT_SHA:
        raise ValueError('Installer differs from the exact reviewed source')
    evidence=root/'evidence';evidence.mkdir(parents=True,exist_ok=True)
    receipt={'status':'started','scope':'actual-public-installer-candidate',
        'installer_source':SOURCE,'installer_sha256':SCRIPT_SHA,'stages':[],
        'previous_package_closure_proof':'38470995390 + 38472747988',
        'server_started':False,'model_started':False,'provider_activation':False,
        'real_provider_acceptance':False,'source_overlay':False}
    def save():(evidence/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    def run(arguments,name,environment=None):
        with (evidence/name).open('wb') as log:
            subprocess.run([str(arg) for arg in arguments],env=environment,stdout=log,
                stderr=subprocess.STDOUT,check=True,cwd=root)
    save()
    try:
        environment=dict(os.environ);environment.pop('PYTHONPATH',None)
        environment['OPENAGENT_INSTALL_ROOT']=str(root/'server')
        run(['sh',script,'--server','--prefix',root/'server-bin'],'server-install.log',environment)
        server=root/'server/venv/bin/python'
        run([server,'-m','pip','check'],'server-pip-check.log',environment)
        run([server,'-m','pip','freeze','--all'],'server-freeze.txt',environment)
        probe=root/'server_probe.py'
        probe.write_text('''import asyncio,importlib.metadata,json,pathlib,sys\nfrom sqlalchemy import text\nfrom sqlalchemy.ext.asyncio import create_async_engine\nimport greenlet,openagent_core,openagent_server,openagent_connectors\nfrom openagent_connectors import ConnectorRunner\nfor module in (greenlet,openagent_core,openagent_server,openagent_connectors):assert pathlib.Path(sys.prefix).resolve() in pathlib.Path(module.__file__).resolve().parents\nassert importlib.metadata.version("openagent-framework")=="1.1.0b39"\nassert importlib.metadata.version("openagent-core")=="1.1.0b22"\nassert importlib.metadata.version("SQLAlchemy")=="2.1.4"\nassert importlib.metadata.version("openagent-connectors")=="0.1.3"\nassert importlib.metadata.version("openagent-host-tools")=="1.0.0b6"\nasync def main():\n root=pathlib.Path(sys.argv[1]);engine=create_async_engine("sqlite+aiosqlite:///"+str(root/"orm-fixture.sqlite"))\n try:\n  async with engine.connect() as connection:assert (await connection.execute(text("SELECT 1"))).scalar_one()==1\n finally:await engine.dispose()\n runner=ConnectorRunner(pathlib.Path(sys.executable).parent/"openagent-connector-runner",identity_file=root/"catalog-identity.json",product="generic-host",name="Installer qualification")\n try:\n  items=await runner.call("catalog");official=[item for item in items if not item.get("nativeKind")];custom=[item for item in items if item.get("nativeKind")]\n  assert len(items)==13 and len(official)==12 and [(item["id"],item["nativeKind"]) for item in custom]==[("custom-mcp","custom_mcp")]\n  print(json.dumps({"imports_from_installed_prefix":True,"async_orm_select_passed":True,"greenlet":greenlet.__version__,"official_catalog_count":12,"custom_catalog_count":1,"provider_calls":0}))\n finally:await runner.close()\nasyncio.run(main())\n''')
        run([server,'-I',probe,root],'server-async-orm-catalog.log',environment)
        receipt['stages'].append('actual-server-installer-pipcheck-async-orm-installed-runner-pass')
        save()
        environment['OPENAGENT_INSTALL_ROOT']=str(root/'cli')
        run(['sh',script,'--cli','--prefix',root/'cli-bin'],'cli-install.log',environment)
        cli=root/'cli/venv/bin/python'
        run([cli,'-m','pip','check'],'cli-pip-check.log',environment)
        run([cli,'-m','pip','freeze','--all'],'cli-freeze.txt',environment)
        run([root/'cli-bin/openagent-cli','--help'],'cli-help.log',environment)
        run([cli,'-I','-c','import importlib.metadata as m; assert m.version("openagent-cli")=="1.1.0b39"; assert not any(d.metadata["Name"] in {"SQLAlchemy","litellm","openai"} for d in m.distributions()); print("thin-client-install-without-engine-dependencies")'],
            'cli-thin-profile.log',environment)
        receipt['stages'].append('actual-cli-installer-pipcheck-help-thin-client-pass')
        receipt['status']='passed'
    except BaseException as error:
        receipt['status']='failed';receipt['reason']=type(error).__name__
        raise
    finally:save()


if __name__=='__main__':main()
