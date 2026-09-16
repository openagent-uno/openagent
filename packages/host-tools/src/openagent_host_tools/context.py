"""Compatibility import; implementation owned by openagent_tool_protocol.context."""
import importlib
import sys
sys.modules[__name__] = importlib.import_module("openagent_tool_protocol.context")
