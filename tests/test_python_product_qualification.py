"""Product qualification must adopt the same complete public module cohort."""
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('product_qualification', ROOT/'scripts/qualify_python_product.py')
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


def pin(name):
    return name + ' @ https://fixture.invalid/' + name.replace('-', '_') + '-1.0-py3-none-any.whl?download=1#sha256=' + '0'*64


class ProductQualification(unittest.TestCase):
    def config(self, extra=()):
        return {'tool': {'uv': {'constraint-dependencies': [
            *(pin(name) for name in ('openagent-core', 'openagent-storage-sqlite', 'openagent-gateway', 'openagent-sdk')),
            *extra]}}}

    def test_optional_sessions_and_full_profiles_are_not_left_on_the_old_installation(self):
        names = ('openagent-module-sessions', 'openagent-modules', 'openagent-modules-full', 'openagent-tool-protocol')
        selected = qualification.pinned_external_wheels(self.config([pin(name) for name in names]))
        self.assertEqual({name for name, _, _ in selected}, {
            'openagent-core', 'openagent-storage-sqlite', 'openagent-gateway', 'openagent-sdk', *names})

    def test_missing_core_duplicate_and_unhashed_wheels_are_rejected(self):
        for extra in ([pin('openagent-core')], ['openagent-modules @ https://fixture.invalid/modules.whl']):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                qualification.pinned_external_wheels(self.config(extra))
        value = self.config()
        value['tool']['uv']['constraint-dependencies'].pop()
        with self.assertRaises(ValueError):
            qualification.pinned_external_wheels(value)

    def test_plain_http_and_credential_bearing_urls_are_not_release_inputs(self):
        for url in ('http://fixture.invalid/module.whl', 'https://user:credential@fixture.invalid/module.whl'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                qualification.pinned_external_wheels(self.config(['openagent-modules @ '+url+'#sha256='+'0'*64]))

    def test_product_config_and_server_follow_the_current_full_module_cohort(self):
        import tomllib
        from urllib.parse import urlsplit
        source = tomllib.loads((ROOT/'apps/server/pyproject.toml').read_text())
        server = source['project']
        config = tomllib.loads((ROOT/'packages/product-config/pyproject.toml').read_text())['project']
        self.assertIn('openagent-product-config=='+config['version'], server['dependencies'])
        pins = {name: url for name, url, _ in qualification.pinned_external_wheels(source)}
        def version(name):
            return Path(urlsplit(pins[name]).path).name.split('-')[1]
        self.assertIn('openagent-modules-full=='+version('openagent-modules-full'), config['dependencies'])
        self.assertIn('openagent-modules=='+version('openagent-modules'), server['dependencies'])
        # A single stale Identity/Support/Transport pin otherwise makes the
        # entire product unsatisfiable despite the server's updated Core pin.
        for component in ('apps/server', 'apps/cli', 'apps/mcp-bridge', 'packages/identity',
                          'packages/dashboards', 'packages/client-transport', 'packages/integrations/support'):
            dependencies = tomllib.loads((ROOT/component/'pyproject.toml').read_text())['project']['dependencies']
            for dependency in dependencies:
                if dependency.startswith(('openagent-core==', 'openagent-core[engine]==', 'openagent-storage-sqlite==')):
                    self.assertEqual(dependency.split('==')[1], version('openagent-core'), component)
