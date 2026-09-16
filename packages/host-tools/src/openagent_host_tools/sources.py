"""Compatibility import; implementation owned by openagent_device_tools.sources."""
import importlib
import sys
sys.modules[__name__] = importlib.import_module("openagent_device_tools.sources")
