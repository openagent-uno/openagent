from openagent_capability_host.config import *
from openagent_capability_host.config import PluginConfigStore as BaseStore
from .paths import HostPaths

class PluginConfigStore(BaseStore):
    def __init__(self, paths=None):
        super().__init__(paths or HostPaths.discover())
