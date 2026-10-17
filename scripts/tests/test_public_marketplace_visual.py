"""Finite hosted source guards; these fixtures are not visual acceptance."""
import hashlib
import argparse
import json
import os
import io
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qualify_public_marketplace_visual as qualifier


class Response(io.BytesIO):
    status = 200


class Contracts(unittest.TestCase):
    def test_wrong_digest_rejects_bytes_before_installer_or_app_execution(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(qualifier.urllib.request, 'urlopen', return_value=Response(b'changed')):
            with self.assertRaises(ValueError):
                qualifier.acquire('https://example.invalid/fixture', Path(tmp) / 'bytes', '0' * 64, 100)

    def test_download_budget_and_exact_size_are_both_required(self):
        digest = hashlib.sha256(b'neutral').hexdigest()
        for budget, size in ((3, 7), (10, 8)):
            with self.subTest(budget=budget, size=size), tempfile.TemporaryDirectory() as tmp, \
                 patch.object(qualifier.urllib.request, 'urlopen', return_value=Response(b'neutral')):
                with self.assertRaises(ValueError):
                    qualifier.acquire('https://example.invalid/fixture', Path(tmp) / 'bytes', digest, budget, size)

    def test_cleanup_targets_only_the_owned_server_group_and_fails_if_still_alive(self):
        child = Mock(pid=12345)
        child.poll.return_value = None
        child.wait.side_effect = qualifier.subprocess.TimeoutExpired(['synthetic'], 1)
        with patch.object(qualifier.os, 'killpg') as kill:
            with self.assertRaises(qualifier.subprocess.TimeoutExpired):
                qualifier.stop_owned_server(child)
            self.assertEqual(kill.call_args_list[0].args, (12345, signal.SIGTERM))
            self.assertEqual(kill.call_args_list[1].args, (12345, signal.SIGKILL))


class WorkerContracts(unittest.TestCase):
    def contract(self):
        value = qualifier.release_contract()
        value.update(appSource='1' * 40, appVersion='1.1.0-beta.18', serverVersion='1.1.0b40',
                     sdkVersion='0.1.4', appRelease='https://github.com/openagent-uno/openagent-app/releases/download/v1.1.0-beta.18/',
                     appDEB='openagent-app-1.1.0-beta.18-linux-amd64.deb', installerBytes=1234,
                     catalogURL='https://github.com/openagent-uno/openagent-tools/releases/download/connectors-v0.1.4/catalog.json',
                     catalogSHA256='2' * 64, catalogBytes=2000)
        return value

    def load(self, value, digest=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'contract.json'
            data = json.dumps(value).encode()
            path.write_bytes(data)
            return qualifier.release_contract(path, digest or hashlib.sha256(data).hexdigest())

    def test_historical_default_preserves_published_cohort(self):
        value = qualifier.release_contract()
        self.assertEqual((value['appVersion'], value['serverVersion'], value['sdkVersion']),
                         ('1.1.0-beta.17', '1.1.0b39', '0.1.3'))

    def test_worker_contract_accepts_only_pinned_finite_public_release(self):
        value = self.contract()
        self.assertEqual(self.load(value), value)
        with self.assertRaises(ValueError):
            self.load(value, '0' * 64)
        for field, replacement in (('appRelease', 'https://example.invalid/'), ('catalogURL', 'http://127.0.0.1/catalog'),
                                   ('appDEBBytes', True), ('appDEBBytes', 513 << 20), ('installerBytes', None),
                                   ('sdkVersion', '0.1.3'), ('appSource', 'main')):
            with self.subTest(field=field, replacement=replacement):
                changed = dict(value, **{field: replacement})
                with self.assertRaises(ValueError):
                    self.load(changed)
        with self.assertRaises(ValueError):
            self.load(dict(value, arbitraryCommand='not-accepted'))

    def test_catalog_requires_exact_unique_fourteen_public_ids(self):
        values = [{'id': 'provider-' + str(i)} for i in range(14)]
        self.assertEqual(qualifier.catalog_ids(values + [{'id': 'custom-mcp', 'nativeKind': 'custom_mcp'}]),
                         sorted(item['id'] for item in values))
        for changed in (values[:-1], values + [{'id': 'provider-0'}], values[:-1] + [{'id': '../escape'}], values[:-1] + [{}]):
            with self.assertRaises(ValueError):
                qualifier.catalog_ids(changed)

    def test_keyless_cohort_requires_matching_app_server_sdk_and_catalog(self):
        value = self.contract()
        value.update(appVersion='1.1.0-beta.19', sdkVersion='0.1.5',
                     appRelease='https://github.com/openagent-uno/openagent-app/releases/download/v1.1.0-beta.19/',
                     appDEB='openagent-app-1.1.0-beta.19-linux-amd64.deb',
                     catalogURL='https://github.com/openagent-uno/openagent-tools/releases/download/connectors-v0.1.5/catalog.json')
        # App19 bytes/source stay fixed while the server-only42 installer fix
        # gains its own finite acceptance cohort; preserve historical19/41.
        for server in ('1.1.0b41', '1.1.0b42'):
            value['serverVersion'] = server
            with self.subTest(server=server):
                self.assertEqual(self.load(value), value)
                for field, replacement in (('serverVersion', '1.1.0b40'), ('serverVersion', '1.1.0b43'),
                                           ('sdkVersion', '0.1.4'), ('hostToolsVersion', '1.0.0b7'),
                                           ('appRelease', self.contract()['appRelease'])):
                    with self.subTest(field=field), self.assertRaises(ValueError):
                        self.load(dict(value, **{field: replacement}))
        with self.assertRaises(ValueError):
            self.load(dict(self.contract(), serverVersion='1.1.0b42'))
        values = [{'id': 'provider-' + str(i)} for i in range(14)] + [{'id': 'exa'}, {'id': 'firecrawl'}]
        self.assertEqual(len(qualifier.catalog_ids(values, '0.1.5')), 16)
        for changed in (values[:-1], values[:-1] + [{'id': 'other'}], values + [{'id': 'exa'}]):
            with self.assertRaises(ValueError):
                qualifier.catalog_ids(changed, '0.1.5')
        with self.assertRaises(ValueError):
            qualifier.catalog_ids(values, '0.1.6')

    def worker_args(self):
        return argparse.Namespace(execution_context='worker-linux', release_contract=Path('/contract.json'),
                                  worker_uid=65532, worker_pod_uid='12345678-1234-1234-1234-123456789abc',
                                  source_commit='1' * 40, run_id='visual18-40', worker_root=Path('/work/evidence-root'))

    def test_worker_rejects_wrong_uid_or_disguised_github_before_git(self):
        for environment, uid in (({'GITHUB_ACTIONS': 'true'}, 65532), ({}, 65531)):
            with patch.dict(os.environ, environment, clear=True), patch.object(qualifier.sys, 'platform', 'linux'), \
                 patch.object(qualifier.os, 'getuid', return_value=uid), patch.object(qualifier.subprocess, 'check_output') as command:
                with self.assertRaises(ValueError):
                    qualifier.execution_context(self.worker_args())
                command.assert_not_called()

    def test_worker_rejects_source_mismatch_before_owned_setup(self):
        environment = {'VISUAL_POD_UID': '12345678-1234-1234-1234-123456789abc'}
        with patch.dict(os.environ, environment, clear=True), patch.object(qualifier.sys, 'platform', 'linux'), \
             patch.object(qualifier.os, 'getuid', return_value=65532), \
             patch.object(qualifier.subprocess, 'check_output', return_value='2' * 40) as command:
            with self.assertRaises(ValueError):
                qualifier.execution_context(self.worker_args())
            self.assertEqual(command.call_count, 1)


if __name__ == '__main__':
    unittest.main()
