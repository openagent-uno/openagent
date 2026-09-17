"""Explicit standalone module graph; installed packages never auto-activate."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Mapping

from openagent_core import ModuleCatalog, ModuleConfig, RuntimeProfile
from openagent_module_attachments import descriptor as attachments
from openagent_module_budget import descriptor as budget
from openagent_module_delegation import descriptor as delegation
from openagent_module_events import descriptor as events
from openagent_module_logs import descriptor as logs
from openagent_module_mcp import descriptor as mcp
from openagent_module_models import descriptor as models
from openagent_module_ptc import descriptor as ptc
from openagent_module_scheduler import descriptor as scheduler
from openagent_module_search import descriptor as search
from openagent_module_sessions import descriptor as sessions
from openagent_module_skills import descriptor as skills
from openagent_module_tool_discovery import descriptor as tool_discovery
from openagent_module_vault import descriptor as vault
from openagent_module_workflows import descriptor as workflows


FULL_DESCRIPTORS = (
    tool_discovery, sessions, search, vault, mcp, workflows, scheduler, events,
    delegation, skills, models, budget, attachments, logs, ptc,
)


def build_module_catalog() -> ModuleCatalog:
    return ModuleCatalog(FULL_DESCRIPTORS)


def standalone_profile(
    *,
    generation: int,
    db_path: str | Path,
    vault_path: str | Path,
    environment: Mapping[str, str],
    mcp_pool_factory: Callable[..., Any],
    automation_runtime: Any | None = None,
    ptc_enabled: bool = False,
    local_e2e: bool = False,
) -> RuntimeProfile:
    shared = {
        "db_path": str(Path(db_path).expanduser().resolve()),
        "environment": dict(environment),
        "target_label": "OpenAgent runtime",
    }
    agent_service_host = frozenset({"service", "agent_tools", "host_api"})
    if local_e2e:
        return RuntimeProfile(generation, {
            "tool-discovery": ModuleConfig(frozenset({"service", "agent_tools"})),
            "sessions": ModuleConfig(agent_service_host),
        })
    modules: dict[str, ModuleConfig] = {
        "tool-discovery": ModuleConfig(frozenset({"service", "agent_tools"})),
        "sessions": ModuleConfig(agent_service_host),
        "search": ModuleConfig(agent_service_host),
        "vault": ModuleConfig(
            agent_service_host,
            {**shared, "vault_path": str(Path(vault_path).expanduser().resolve())},
        ),
        "mcp": ModuleConfig(
            agent_service_host,
            {**shared, "catalog_mode": "dynamic", "pool_factory": mcp_pool_factory,
             "target_label": "OpenAgent MCP catalog"},
        ),
        "workflows": ModuleConfig(
            frozenset({"service", "agent_tools", "host_api", "workers"})
                if automation_runtime is not None else agent_service_host,
            {**shared, "workers": (automation_runtime.worker("workflows"),)}
                if automation_runtime is not None else shared,
        ),
        "scheduler": ModuleConfig(
            frozenset({"service", "agent_tools", "host_api", "workers"})
                if automation_runtime is not None else agent_service_host,
            {**shared, "workers": (automation_runtime.worker("scheduler"),)}
                if automation_runtime is not None else shared,
        ),
        "events": ModuleConfig(
            frozenset({"service", "agent_tools", "host_api", "workers", "event_ingress"})
                if automation_runtime is not None else agent_service_host,
            {**shared, "workers": (automation_runtime.worker("events"),)}
                if automation_runtime is not None else shared,
        ),
        "delegation": ModuleConfig(agent_service_host, shared),
        "skills": ModuleConfig(agent_service_host, shared),
        "models": ModuleConfig(agent_service_host, shared),
        "budget": ModuleConfig(agent_service_host, shared),
        "attachments": ModuleConfig(agent_service_host, shared),
        "logs": ModuleConfig(agent_service_host, shared),
    }
    if ptc_enabled:
        modules["ptc"] = ModuleConfig(agent_service_host, shared)
    return RuntimeProfile(generation, modules)


__all__ = ["FULL_DESCRIPTORS", "build_module_catalog", "standalone_profile"]
