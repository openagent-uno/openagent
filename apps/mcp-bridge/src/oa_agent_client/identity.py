"""Compatibility imports from the single standalone identity implementation."""
from importlib import import_module as _import_module
_implementation=_import_module('openagent_identity.identity')
__all__=getattr(_implementation,"__all__",tuple(name for name in vars(_implementation) if not name.startswith("_")))
def __getattr__(name):
    return getattr(_implementation,name)
def __dir__():
    return sorted(set(globals())|set(dir(_implementation)))
