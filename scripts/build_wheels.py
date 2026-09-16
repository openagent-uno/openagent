#!/usr/bin/env python3
"""Build product wheels from a clean source snapshot and verify unique ownership."""
from __future__ import annotations
import argparse
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT=Path(__file__).resolve().parents[1]


def verify_ownership(wheels):
    owners={}
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            for name in archive.namelist():
                if name.endswith('/') or '.dist-info/' in name:
                    continue
                if name in owners:
                    raise ValueError(f'{name} is shipped by both {owners[name]} and {wheel.name}')
                owners[name]=wheel.name
    return owners


def build(output,components=()):
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True)
    if any(output.glob('*.whl')):
        raise ValueError('Use an empty output directory for each source snapshot')
    configuration=json.loads((ROOT/'packaging/workspace.json').read_text())['components']
    selected={name:value for name,value in configuration.items() if value['kind']=='python' and (not components or name in components)}
    if components and set(components)-selected.keys():
        raise ValueError('Unknown or non-Python component')
    uv=shutil.which('uv')
    if not uv:
        raise RuntimeError('The uv build frontend must be installed')
    paths=tuple(value['path']+'/' for value in selected.values())
    names=subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=ROOT).decode().split('\0')
    hashes={}
    with tempfile.TemporaryDirectory(prefix='openagent-product-build-') as temporary:
        snapshot=Path(temporary)
        for name in sorted(set(names)-{''}):
            if not name.startswith(paths):continue
            source=ROOT/name
            if not source.is_file():continue
            if source.is_symlink():raise ValueError('A source snapshot cannot follow symlinks: '+name)
            data=source.read_bytes();hashes[name]=hashlib.sha256(data).hexdigest()
            target=snapshot/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);shutil.copymode(source,target)
        for name,value in selected.items():
            result=subprocess.run([uv,'build','--wheel','--out-dir',str(output),str(snapshot/value['path'])],
                stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
            if result.returncode:
                raise RuntimeError(f'Build failed for {name}:\n{result.stdout}')
            print('Built '+name,flush=True)
    wheels=sorted(output.glob('*.whl'))
    verify_ownership(wheels)
    entries=[]
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            info=BytesParser().parsebytes(archive.read(next(name for name in archive.namelist() if name.endswith('.dist-info/METADATA'))))
        entries.append({'file':wheel.name,'name':info['Name'],'version':info['Version'],
            'sha256':hashlib.sha256(wheel.read_bytes()).hexdigest(),'bytes':wheel.stat().st_size})
    manifest={'format':1,'repository_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'dirty_snapshot':bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True)),
        'qualification':'development-unqualified','sources':hashes,
        'source_sha256':hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
        'wheels':entries}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--components',nargs='*',default=[])
    options=parser.parse_args()
    build(options.out,options.components)
