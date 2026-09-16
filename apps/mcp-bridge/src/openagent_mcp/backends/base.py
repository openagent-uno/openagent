"""The Backend protocol + the Target descriptor shared by every backend."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class Target:
    """A reachable OpenAgent agent.

    ``name`` is the opaque alias the model uses (the ONLY token it sees).
    ``node_id`` / ``relay_url`` / ``addresses`` are the connection
    descriptor and are never surfaced to the model.
    """

    name: str
    node_id: str
    description: str = ""
    relay_url: str | None = None
    addresses: tuple[str, ...] | None = None


@runtime_checkable
class Backend(Protocol):
    """Resolves target names and performs the wire call.

    ``default_timeout`` (seconds) bounds a dial when the caller doesn't
    specify one; the tool layer clamps any caller value to it. Keep it
    generous — long jobs persist to the session and are resumable, so a
    short cap only forces needless polling.
    """

    default_timeout: float

    async def list_targets(self) -> list[Target]:
        ...

    async def dial(
        self,
        target: Target,
        message: str,
        session_id: str | None,
        timeout: float,
    ) -> dict:
        """Send *message* to *target* and return its raw JSON reply
        (``{response, model, errored}`` + ``{session_id, created}`` once the
        target runs the peer-session patch)."""
        ...
