"""Select the optional code environment from standalone configuration only."""

from __future__ import annotations
from dataclasses import fields
import sys


def build_code_executor(config, environment):
    from openagent_core.core.config import ptc_settings

    settings = ptc_settings(config)
    if not settings.enabled:
        return None
    from openagent_execution import (
        ProcessCodeExecutor,
        LocalBackend,
        DockerBackend,
        DockerConfig,
    )

    sandbox = config.get("sandbox") or {}
    backend = str(sandbox.get("backend") or "local").strip().lower()
    # Code never inherits credential variables just because the product knows
    # them. Explicit forwarding into a provisioned container stays host policy.
    safe = {
        name: environment[name]
        for name in (
            "PATH",
            "HOME",
            "TMPDIR",
            "TEMP",
            "TMP",
            "SYSTEMROOT",
            "COMSPEC",
            "SHELL",
        )
        if name in environment
    }
    if backend == "local":
        if settings.require_sandbox:
            raise ValueError("PTC requires an explicitly configured isolated executor")
        return ProcessCodeExecutor(
            backend=LocalBackend(environment=safe),
            python_executable=sys.executable,
            bridge_transport="unix",
            isolated=False,
            environment=safe,
        )
    if backend == "docker":
        raw = sandbox.get("docker") or {}
        allowed = {field.name for field in fields(DockerConfig)}
        unknown = set(raw) - allowed
        if unknown:
            raise ValueError(
                "Unknown Docker executor configuration: " + ", ".join(sorted(unknown))
            )
        values = dict(raw)
        if "forward_env" in values:
            values["forward_env"] = tuple(values["forward_env"])
        selected = DockerConfig(**values)
        client_environment = {
            **safe,
            **{
                key: environment[key]
                for key in selected.forward_env
                if key in environment
            },
        }
        return ProcessCodeExecutor(
            backend=DockerBackend(selected, environment=client_environment),
            python_executable="python3",
            bridge_transport="files",
            isolated=True,
            environment={},
            workdir=selected.workdir,
        )
    raise ValueError(
        f"PTC executor {backend!r} has no supported isolated RPC transport"
    )
