"""Standalone defaults layered onto mandatory OpenAgent framework rules."""
from .prompts import product_prompt_blocks, configure_product_prompts
from .modules import build_module_catalog, standalone_profile
__all__ = ["product_prompt_blocks", "configure_product_prompts",
           "build_module_catalog", "standalone_profile"]
