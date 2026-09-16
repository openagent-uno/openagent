"""Compatibility import; implementation owned by openagent_capability_host.audit."""
import importlib
import sys
sys.modules[__name__] = importlib.import_module("openagent_capability_host.audit")
