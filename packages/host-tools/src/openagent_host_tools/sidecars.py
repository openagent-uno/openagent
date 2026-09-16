"""Product bundle version adapter for independent sidecar discovery."""
from openagent_device_tools.sidecars import *
from openagent_device_tools import sidecars as _impl
from openagent_device_tools.sidecars import _VERIFIED_BUNDLES, _parse_command
from ._version import __version__

def discover_sidecars():
    return _impl.discover_sidecars(bundle_version=__version__)

def _discover(*args, **kwargs):
    return _impl._discover(*args, bundle_version=__version__, **kwargs)

def _discover_agent_in_chrome():
    return _impl._discover_agent_in_chrome(bundle_version=__version__)

def _bundle_integrity_error(root):
    return _impl._bundle_integrity_error(root, bundle_version=__version__)
