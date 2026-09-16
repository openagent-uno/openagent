from openagent_capability_host.consent import *
from openagent_capability_host.consent import ConsentStore as BaseStore
from .paths import HostPaths

class ConsentStore(BaseStore):
    def __init__(self, paths=None):
        super().__init__(paths or HostPaths.discover())
