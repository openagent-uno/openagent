"""Compatibility alias for shared channel tool_labels."""
import sys
from openagent_channel_bridges import tool_labels as _shared
sys.modules[__name__] = _shared
