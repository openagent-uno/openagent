"""Public package visual qualification on GitHub or an explicit isolated worker."""
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
import tempfile
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


def release_contract(path=None, digest=None):
    historical = {'appSource': APP_SOURCE, 'appVersion': '1.1.0-beta.17',
        'serverVersion': '1.1.0b39', 'coreVersion': '1.1.0b22', 'sdkVersion': '0.1.3',
        'hostToolsVersion': '1.0.0b6', 'appRelease': APP_RELEASE, 'appDEB': DEB,
        'appDEBSHA256': DEB_SHA, 'appDEBBytes': 198247284,
        'appManifestSHA256': MANIFEST_SHA, 'appManifestBytes': 1131,
        'hostToolsIndexSHA256': 'a0f85b84e6d98f525c466126df7a5de9437d9628127607517a94f1b61b1889e0',
        'installerURL': INSTALLER_URL, 'installerSHA256': INSTALLER_SHA,
        'installerBytes': None, 'catalogURL': None, 'catalogSHA256': None, 'catalogBytes': None}
    if path is None:
        require(digest is None)
        return historical
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 16384)
    data = path.read_bytes()
    require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest)
            and hashlib.sha256(data).hexdigest() == digest)
    value = json.loads(data)
    require(isinstance(value, dict) and set(value) == set(historical))
    # This worker cohort is explicit; it does not accept arbitrary executables or installers.
    require((value['appVersion'], value['serverVersion'], value['coreVersion'], value['sdkVersion'], value['hostToolsVersion']) in {
        ('1.1.0-beta.18', '1.1.0b40', '1.1.0b22', '0.1.4', '1.0.0b6'),
        ('1.1.0-beta.19', '1.1.0b41', '1.1.0b22', '0.1.5', '1.0.0b6'),
        ('1.1.0-beta.19', '1.1.0b42', '1.1.0b22', '0.1.5', '1.0.0b6'),
        ('1.1.0-beta.20', '1.1.0b43', '1.1.0b22', '0.1.6', '1.0.0b6'),
        ('1.1.0-beta.21', '1.1.0b44', '1.1.0b22', '0.1.7', '1.0.0b6'),
    })
    require(value['appRelease'] == 'https://github.com/openagent-uno/openagent-app/releases/download/v' + value['appVersion'] + '/'
            and value['appDEB'] == 'openagent-app-' + value['appVersion'] + '-linux-amd64.deb'
            and value['installerURL'] == 'https://openagent.uno/install.sh'
            and value['catalogURL'] == 'https://github.com/openagent-uno/openagent-tools/releases/download/connectors-v' + value['sdkVersion'] + '/catalog.json')
    require(isinstance(value['appSource'], str) and re.fullmatch('[0-9a-f]{40}', value['appSource']))
    for key in ('appDEBSHA256', 'appManifestSHA256', 'hostToolsIndexSHA256', 'installerSHA256', 'catalogSHA256'):
        require(isinstance(value[key], str) and re.fullmatch('[0-9a-f]{64}', value[key]))
    for key, limit in (('appDEBBytes', 512 << 20), ('appManifestBytes', 65536), ('installerBytes', 100000), ('catalogBytes', 1 << 20)):
        require(type(value[key]) is int and 0 < value[key] <= limit)
    return value


def catalog_ids(catalog, sdk_version='0.1.4'):
    require(sdk_version in {'0.1.4', '0.1.5', '0.1.6', '0.1.7'})
    require(isinstance(catalog, list) and all(isinstance(item, dict) for item in catalog))
    ids = [item.get('id') for item in catalog if not item.get('nativeKind')]
    require(all(isinstance(item, str) and re.fullmatch('[a-z0-9_-]{1,64}', item) for item in ids))
    require(len(ids) == len(set(ids)) == {'0.1.4': 14, '0.1.5': 16, '0.1.6': 19, '0.1.7': 22}[sdk_version])
    if sdk_version in {'0.1.5', '0.1.6', '0.1.7'}:
        require({'exa', 'firecrawl'} <= set(ids))
    if sdk_version in {'0.1.6', '0.1.7'}:
        expected = {'atlassian', 'billingbear', 'clickup', 'coingecko', 'context7',
                            'exa', 'firecrawl', 'github', 'gmail', 'google-analytics',
                            'google-drive', 'imap_smtp', 'notion', 'parallel-search',
                            'pipeboard', 'postiz', 'replio', 'shopify', 'slack-import'}
        if sdk_version == '0.1.7':
            expected |= {'google-calendar', 'outlook-mail', 'outlook-calendar'}
        require(set(ids) == expected)
    return sorted(ids)


def execution_context(args):
    require(sys.platform == 'linux')
    if args.execution_context == 'github':
        require(os.environ.get('GITHUB_ACTIONS') == 'true' and args.release_contract is None)
        source = os.environ.get('QUALIFIER_SOURCE', '')
        require(re.fullmatch('[0-9a-f]{40}', source) and source == os.environ.get('GITHUB_SHA'))
        return source, os.environ['GITHUB_RUN_ID'], Path(os.environ['RUNNER_TEMP']).resolve(), {'executionContext': 'github'}
    require(os.environ.get('GITHUB_ACTIONS') is None and args.release_contract is not None)
    require(args.worker_uid is not None and args.worker_uid > 0 and os.getuid() == args.worker_uid)
    require(isinstance(args.worker_pod_uid, str) and re.fullmatch('[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', args.worker_pod_uid)
            and args.worker_pod_uid == os.environ.get('VISUAL_POD_UID'))
    require(isinstance(args.source_commit, str) and re.fullmatch('[0-9a-f]{40}', args.source_commit)
            and isinstance(args.run_id, str) and re.fullmatch('[A-Za-z0-9_-]{1,64}', args.run_id))
    checkout = Path(__file__).resolve().parents[1]
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip() == args.source_commit
            and not subprocess.check_output(['git', 'status', '--porcelain'], cwd=checkout).strip())
    require(args.worker_root is not None and args.worker_root.is_absolute() and not args.worker_root.is_symlink())
    owned = args.worker_root.resolve()
    require(owned == args.worker_root and owned.is_dir() and owned.stat().st_uid == os.getuid() and owned.stat().st_mode & 0o077 == 0)
    return args.source_commit, args.run_id, owned, {'executionContext': 'worker-linux', 'workerUID': os.getuid(), 'workerPodUID': args.worker_pod_uid}



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
    parser.add_argument('--execution-context', choices=('github', 'worker-linux'), default='github')
    parser.add_argument('--source-commit')
    parser.add_argument('--run-id')
    parser.add_argument('--worker-uid', type=int)
    parser.add_argument('--worker-pod-uid')
    parser.add_argument('--worker-root', type=Path)
    parser.add_argument('--release-contract', type=Path)
    parser.add_argument('--release-contract-sha256')
    args = parser.parse_args()
    os.umask(0o077)
    source, run_id, runner_temporary, execution = execution_context(args)
    release = release_contract(args.release_contract, args.release_contract_sha256)
    temporary = Path(tempfile.gettempdir()).resolve()
    root = temporary / ('marketplace-public-qa-' + run_id)
    evidence = args.evidence.resolve()
    require(not root.exists() and root.parent == temporary and evidence.parent == runner_temporary)
    root.mkdir(mode=0o700); evidence.mkdir(mode=0o700, exist_ok=False)
    ownership = (root.stat().st_dev, root.stat().st_ino)
    receipt = {'status': 'started', 'qualifierSource': source, 'appSource': release['appSource'],
               'appVersion': release['appVersion'], 'serverVersion': release['serverVersion'],
               'appDEBSHA256': release['appDEBSHA256'], 'installerURL': release['installerURL'],
               'installerSHA256': release['installerSHA256'], **execution, 'sourceOverlay': False,
               'realProviderOAuth': False, 'providerCalls': 0, 'publicPromotion': False,
               'personalProfilesUsed': False, 'phase': 'acquire-public-bytes'}
    def save():
        (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    save()
    server = None
    try:
        acquire(release['appRelease'] + release['appDEB'], root / release['appDEB'], release['appDEBSHA256'], release['appDEBBytes'], release['appDEBBytes'])
        acquire(release['appRelease'] + 'release-manifest-linux-x64.json', root / 'app-manifest.json', release['appManifestSHA256'], release['appManifestBytes'], release['appManifestBytes'])
        manifest = json.loads((root / 'app-manifest.json').read_bytes())
        binding = manifest['canonical_source']
        require(manifest['version'] == release['appVersion'] and manifest['runner'] == 'linux-x64'
                and binding['source_commit'] == release['appSource'] and binding['app_id'] == 'ai.openagent.desktop'
                and binding['host_tools_lock_sha256'] == release['hostToolsIndexSHA256'])
        acquire(release['installerURL'], root / 'install.sh', release['installerSHA256'], 100000, release['installerBytes'])
        expected_ids = None
        if args.execution_context == 'worker-linux':
            acquire(release['catalogURL'], root / 'catalog.json', release['catalogSHA256'], 1 << 20, release['catalogBytes'])
            catalog = json.loads((root / 'catalog.json').read_bytes())
            expected_ids = catalog_ids(catalog, release['sdkVersion'])
            receipt['catalogSHA256'] = release['catalogSHA256']
        ui_expectation = {'appVersion': release['appVersion'], 'serverVersion': release['serverVersion'], 'officialIds': expected_ids}
        (root / 'ui-expectation.json').write_text(json.dumps(ui_expectation))
        environment = dict(os.environ)
        for key in ('PYTHONPATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAGENT_DESKTOP_E2E',
                    'OPENAGENT_DESKTOP_E2E_LOOPBACK', 'OPENAGENT_DESKTOP_E2E_RENDERER_URL'):
            environment.pop(key, None)
        home = root / 'home'; home.mkdir(mode=0o700)
        environment.update(OPENAGENT_USER_DIR=str(home / 'user'), OPENAGENT_HOST_TOOLS_HOME=str(home / 'host-tools'),
                           XDG_CONFIG_HOME=str(home / '.config'), XDG_DATA_HOME=str(home / '.local/share'),
                           XDG_CACHE_HOME=str(home / '.cache'), OPENAGENT_INSTALL_ROOT=str(root / 'server'),
                           PYTHONUNBUFFERED='1', OPENAGENT_IROH_DISCOVERY='none', TMPDIR=str(temporary))
        receipt['ownedProfileUnderOSTempRoot'] = True
        receipt['phase'] = 'install-public-server'; save()
        run(['sh', str(root / 'install.sh'), '--server', '--prefix', str(root / 'bin')], root, environment)
        python = root / 'server/venv/bin/python'
        run([str(python), '-m', 'pip', 'check'], root, environment)
        versions = json.loads(run([str(python), '-I', '-c',
            "import importlib.metadata as m,json;print(json.dumps({n:m.version(n) for n in ['openagent-framework','openagent-core','openagent-connectors','openagent-host-tools']}))"], root, environment))
        require(versions == {'openagent-framework': release['serverVersion'], 'openagent-core': release['coreVersion'],
                             'openagent-connectors': release['sdkVersion'], 'openagent-host-tools': release['hostToolsVersion']})
        receipt['installedVersions'] = versions
        receipt['phase'] = 'extract-public-deb'; save()
        payload = root / 'app'; payload.mkdir()
        run(['dpkg-deb', '--extract', str(root / release['appDEB']), str(payload)], root, environment)
        receipt['phase'] = 'verify-public-payload-layout'; save()
        executables = [p for p in payload.rglob('openagent-desktop') if p.is_file() and not p.is_symlink() and os.access(p, os.X_OK)]
        require(len(executables) == 1)
        executable = executables[0]
        require((executable.parent / 'resources/app.asar').is_file()
                and (executable.parent / 'resources/web-build/index.html').is_file())
        profile = root / 'app-profile'; profile.mkdir(mode=0o700)
        receipt['phase'] = 'launch-public-packaged-smoke'; save()
        run([str(executable), '--no-sandbox', '--local-e2e', '--e2e-user-data-dir=' + str(profile),
             '--packaged-smoke', '--expected-version=' + release['appVersion']], root, environment, timeout=60)
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
        ui = json.loads(run(['node', str(driver), str(executable), str(profile), str(args.driver_root.resolve()), str(evidence), str(root / 'ui-expectation.json')],
                            root, environment, input_data=invitation, timeout=240))
        require(ui['status'] == 'passed' and ui['officialCount'] == (len(expected_ids) if expected_ids is not None else 12)
                and (expected_ids is None or ui['officialIds'] == expected_ids) and ui['registryCount'] > 0
                and ui['clientCleanupConfirmed'] is True)
        receipt['ui'] = ui; receipt['phase'] = 'owned-cleanup'; save()
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['reason'] = 'timeout' if isinstance(error, subprocess.TimeoutExpired) else type(error).__name__
        raise SystemExit('PUBLIC_MARKETPLACE_VISUAL_FAILED') from None
    finally:
        try:
            stop_owned_server(server)
            require(root.is_dir() and not root.is_symlink() and root.stat().st_uid == os.getuid()
                    and (root.stat().st_dev, root.stat().st_ino) == ownership)
            shutil.rmtree(root)
            require(not root.exists())
            receipt['ownedStagingCleanupConfirmed'] = True
        except Exception:
            receipt['status'] = 'failed'; receipt['reason'] = 'owned-cleanup-failed'
            save()
            raise SystemExit('PUBLIC_MARKETPLACE_VISUAL_CLEANUP_FAILED') from None
        save()
    receipt['status'] = 'passed'; receipt['phase'] = 'complete'; save()
    print('PUBLIC_MARKETPLACE_VISUAL_PASS')


if __name__ == '__main__':
    main()
