"""Compatibility import; implementation owned by openagent_shell.shell_core."""
import importlib
import sys
sys.modules[__name__] = importlib.import_module("openagent_shell.shell_core")
