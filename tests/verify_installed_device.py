"""Verify installed device integration without resolving source packages."""
from importlib import metadata, util
from pathlib import Path
import shutil
import site
import sys
import tempfile
import unittest

roots = [Path(value).resolve() for value in site.getsitepackages()]
for module, distribution in (
    ('openagent_core', 'openagent-core'), ('openagent_server', 'openagent-framework'),
    ('openagent_identity', 'openagent-identity'), ('openagent_storage_sqlite', 'openagent-storage-sqlite'),
    ('openagent_host_tools', 'openagent-host-tools'), ('openagent_capability_host', 'openagent-capability-host'),
    ('openagent_filesystem', 'openagent-filesystem'), ('openagent_editor', 'openagent-editor'),
    ('openagent_shell', 'openagent-shell'),
):
    specification = util.find_spec(module)
    if specification is None or specification.origin is None:
        raise RuntimeError(f'{distribution} is not installed')
    origin = Path(specification.origin).resolve()
    if not any(origin.is_relative_to(root) for root in roots):
        raise RuntimeError(f'{module} resolves outside installed packages: {origin}')
    print(f'{distribution}=={metadata.version(distribution)}: {origin}', flush=True)

with tempfile.TemporaryDirectory(prefix='openagent-installed-device-tests-') as temporary:
    directory = Path(temporary)
    source = Path(__file__).resolve().parent
    for name in ('iroh_device_fixture.py','test_installed_iroh_startup.py','test_installed_iroh_device.py'):
        shutil.copy2(source/name, directory/name)
    suite = unittest.defaultTestLoader.discover(str(directory), pattern='test_installed_iroh_device.py')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
