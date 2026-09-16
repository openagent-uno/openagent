"""Product prompt contributions; framework and vault rules are owned by Core.

Dashboard documentation is contributed only after the caller checks the
current authenticated capability catalog. A connected app alone is not proof
that the current turn can use its dashboard service.
"""
from __future__ import annotations

from importlib.resources import files
import json
from typing import Any, Callable, Mapping

_DEFAULT_IDS = frozenset({
    "product.persona", "product.proactivity", "product.network",
    "product.autonomy", "product.delegation-preference", "product.identity-management",
})


def product_prompt_blocks(*, dashboard_capability: bool = False) -> tuple[dict[str, str], ...]:
    blocks = json.loads(files(__package__).joinpath("prompt-blocks.json").read_text())
    selected = _DEFAULT_IDS | ({"product.dashboards"} if dashboard_capability else set())
    return tuple(dict(block) for block in blocks if block["id"] in selected)


def configure_product_prompts(config: Mapping[str, Any]) -> dict[str, Any]:
    """Create standalone assembly config without modifying the caller's dict."""
    result = dict(config)
    result["_host_prompt_blocks"] = list(product_prompt_blocks())
    return result


class ProductPromptProvider:
    """Host contribution provider with an optional trusted capability check."""

    def __init__(self, dashboard_available: Callable[[Any], bool] | None = None):
        self._dashboard_available = dashboard_available

    def prompt_blocks(self, context: Any) -> tuple[dict[str, str], ...]:
        available = bool(self._dashboard_available and self._dashboard_available(context))
        return product_prompt_blocks(dashboard_capability=available)
