"""Hosted-only public package visual qualification; no build or auth shortcuts."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

APP_SOURCE = '0b00b5bde99fbbe5685f7906a7d1596c6e0d85fb'
APP_RELEASE = 'https://github.com/openagent-uno/openagent-app/releases/download/v1.1.0-beta.17/'
DEB = 'openagent-app-1.1.0-beta.17-linux-amd64.deb'
DEB_SHA = '7c62eb994b72cfdd711b391f0eb0bcf437ac00356c6d4b2bd56044763e0a59b4'
MANIFEST_SHA = 'cbebbfbccaa2cf8bd2191dcb39b88a2b230872770333e8a35dbe36245f81fcce'
INSTALLER_URL = 'https://openagent.uno/install.sh'
INSTALLER_SHA = 'ccc9e983d9df31e393fdfeaccbb37ea61977cc9fb7a7bb61953e96115527fac9'


def require(value):
    if not value:
        raise ValueError('visual-contract-rejected')


def acquire(url, target, digest, limit, exact_size=None):
    hasher, size = hashlib.sha256(), 0
    with urllib.request.urlopen(url, timeout=60) as response, target.open('xb') as output:
        require(response.status == 200)
        while block := response.read(512 << 10):
            size += len(block)
            require(size <= limit)
            hasher.update(block)
            output.write(block)
    require(hasher.hexdigest() == digest and (exact_size is None or size == exact_size))


def run(arguments, root, environment, *, input_data=None, timeout=900):
    child = subprocess.Popen(arguments, cwd=root, env=environment, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = child.communicate(input=input_data, timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise
    require(len(stdout) + len(stderr) <= 8 << 20)
    if child.returncode:
        raise RuntimeError('owned-command-failed')
    return stdout


def stop_owned_server(child):
    if child is None:
        return
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
    require(child.poll() is not None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--driver-root', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux')
    source = os.environ.get('QUALIFIER_SOURCE', '')
    require(re.fullmatch('[0-9a-f]{40}', source) and source == os.environ.get('GITHUB_SHA'))
    temporary = Path(os.environ['RUNNER_TEMP']).resolve()
    root = temporary / ('marketplace-public-qa-' + os.environ['GITHUB_RUN_ID'])
    evidence = args.evidence.resolve()
    require(not root.exists() and root.parent == temporary and evidence.parent == temporary)
    root.mkdir(mode=0o700); evidence.mkdir(mode=0o700, exist_ok=False)
    ownership = (root.stat().st_dev, root.stat().st_ino)
    receipt = {'status': 'started', 'qualifierSource': source, 'appSource': APP_SOURCE,
               'appVersion': '1.1.0-beta.17', 'serverVersion': '1.1.0b39',
               'appDEBSHA256': DEB_SHA, 'installerURL': INSTALLER_URL,
               'installerSHA256': INSTALLER_SHA, 'sourceOverlay': False,
               'realProviderOAuth': False, 'providerCalls': 0, 'publicPromotion': False,
               'personalProfilesUsed': False, 'phase': 'acquire-public-bytes'}
    def save():
        (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    save()
    server = None
    try:
        acquire(APP_RELEASE + DEB, root / DEB, DEB_SHA, 198247284, 198247284)
        acquire(APP_RELEASE + 'release-manifest-linux-x64.json', root / 'app-manifest.json', MANIFEST_SHA, 1131, 1131)
        manifest = json.loads((root / 'app-manifest.json').read_bytes())
        binding = manifest['canonical_source']
        require(manifest['version'] == '1.1.0-beta.17' and manifest['runner'] == 'linux-x64'
                and binding['source_commit'] == APP_SOURCE and binding['app_id'] == 'ai.openagent.desktop'
                and binding['host_tools_lock_sha256'] == 'a0f85b84e6d98f525c466126df7a5de9437d9628127607517a94f1b61b1889e0')
        acquire(INSTALLER_URL, root / 'install.sh', INSTALLER_SHA, 100000)
        environment = dict(os.environ)
        for key in ('PYTHONPATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAGENT_DESKTOP_E2E',
                    'OPENAGENT_DESKTOP_E2E_LOOPBACK', 'OPENAGENT_DESKTOP_E2E_RENDERER_URL'):
            environment.pop(key, None)
        home = root / 'home'; home.mkdir(mode=0o700)
        environment.update(HOME=str(home), USERPROFILE=str(home), XDG_CONFIG_HOME=str(home / '.config'),
                           XDG_CACHE_HOME=str(home / '.cache'), OPENAGENT_INSTALL_ROOT=str(root / 'server'),
                           PYTHONUNBUFFERED='1', OPENAGENT_IROH_DISCOVERY='none')
        receipt['phase'] = 'install-public-server'; save()
        run(['sh', str(root / 'install.sh'), '--server', '--prefix', str(root / 'bin')], root, environment)
        python = root / 'server/venv/bin/python'
        run([str(python), '-m', 'pip', 'check'], root, environment)
        versions = json.loads(run([str(python), '-I', '-c',
            "import importlib.metadata as m,json;print(json.dumps({n:m.version(n) for n in ['openagent-framework','openagent-core','openagent-connectors','openagent-host-tools']}))"], root, environment))
        require(versions == {'openagent-framework': '1.1.0b39', 'openagent-core': '1.1.0b22',
                             'openagent-connectors': '0.1.3', 'openagent-host-tools': '1.0.0b6'})
        receipt['installedVersions'] = versions
        payload = root / 'app'; payload.mkdir()
        run(['dpkg-deb', '--extract', str(root / DEB), str(payload)], root, environment)
        executables = [p for p in payload.rglob('openagent-desktop') if p.is_file() and not p.is_symlink() and os.access(p, os.X_OK)]
        require(len(executables) == 1)
        executable = executables[0]
        require((executable.parent / 'resources/app.asar').is_file()
                and (executable.parent / 'resources/web-build/index.html').is_file())
        profile = root / 'app-profile'; profile.mkdir(mode=0o700)
        run([str(executable), '--no-sandbox', '--local-e2e', '--e2e-user-data-dir=' + str(profile),
             '--packaged-smoke', '--expected-version=1.1.0-beta.17'], root, environment, timeout=60)
        receipt['phase'] = 'normal-server-bootstrap'; save()
        agent = root / 'agent'
        command = root / 'bin/openagent'
        run([str(command), 'init', str(agent)], root, environment, timeout=60)
        # Change only the newly owned ordinary configuration, never a DB or auth row.
        run([str(python), '-I', '-c',
             "import pathlib,yaml,sys;p=pathlib.Path(sys.argv[1]);c=yaml.safe_load(p.read_text());c['name']='openagent-visual-qa';c['voice']={'prefetch':False};c['server_host_tools']={'tools':[]};p.write_text(yaml.safe_dump(c))",
             str(agent / 'openagent.yaml')], root, environment, timeout=30)
        with (root / 'private-server.log').open('wb') as log:
            server = subprocess.Popen([str(command), 'serve', str(agent), '--channel', 'gateway'],
                                      cwd=root, env=environment, stdout=log, stderr=log, start_new_session=True)
        ticket = None
        for _ in range(120):
            require(server.poll() is None)
            body = (root / 'private-server.log').read_bytes()
            require(len(body) <= 4 << 20)
            found = re.search(rb'^oa1[A-Za-z0-9_-]{20,10000}\r?$', body, re.M)
            if found:
                ticket = found.group().decode().strip(); break
            time.sleep(1)
        require(ticket is not None)
        receipt['phase'] = 'ordinary-ui-enrollment-and-marketplace'; save()
        invitation = json.dumps({'ticket': ticket, 'handle': 'visualqa', 'password': secrets.token_urlsafe(32)}).encode()
        driver = Path(__file__).with_name('public_marketplace_visual.mjs')
        ui = json.loads(run(['node', str(driver), str(executable), str(profile), str(args.driver_root.resolve()), str(evidence)],
                            root, environment, input_data=invitation, timeout=240))
        require(ui['status'] == 'passed' and ui['officialCount'] == 12 and ui['registryCount'] > 0
                and ui['clientCleanupConfirmed'] is True)
        receipt['ui'] = ui; receipt['phase'] = 'owned-cleanup'; save()
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['reason'] = 'timeout' if isinstance(error, subprocess.TimeoutExpired) else type(error).__name__
        raise SystemExit('PUBLIC_MARKETPLACE_VISUAL_FAILED') from None
    finally:
        try:
            stop_owned_server(server)
            require(root.is_dir() and not root.is_symlink() and (root.stat().st_dev, root.stat().st_ino) == ownership)
            shutil.rmtree(root)
            require(not root.exists())
            receipt['ownedStagingCleanupConfirmed'] = True
        except Exception:
            receipt['status'] = 'failed'; receipt['reason'] = 'owned-cleanup-failed'
            save()
            raise SystemExit('PUBLIC_MARKETPLACE_VISUAL_CLEANUP_FAILED') from None
        save()
    receipt['status'] = 'passed'; receipt['phase'] = 'complete'; save()
    print('PUBLIC_APP17_SERVER39_MARKETPLACE_VISUAL_PASS')


if __name__ == '__main__':
    main()
