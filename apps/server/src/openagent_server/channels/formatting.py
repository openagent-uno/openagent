"""Compatibility alias for shared channel formatting."""
import sys
from openagent_channel_bridges import formatting as _shared
sys.modules[__name__] = _shared
