"""Compatibility alias for shared channel commands."""
import sys
from openagent_channel_bridges import commands as _shared
sys.modules[__name__] = _shared
