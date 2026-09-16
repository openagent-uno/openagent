"""Embedded coordinator service: PAKE login, device-cert issuance, agent registry.

Activated when ``network.coordinator.enabled: true`` in the agent config
(or when ``openagent network init`` has flipped the singleton ``network``
row to ``role='coordinator'``). Listens on its own Iroh ALPN
(``openagent/coordinator/1``) so it can run alongside the gateway on
the same Iroh endpoint.
"""

from openagent_identity.coordinator.pake import (
    PakeBackend,
    Srp6aBackend,
    LoginInProgress,
    PakeError,
)
def __getattr__(name):
    # Client-side PAKE must not import the server coordinator or database.
    if name == "CoordinatorService":
        from openagent_identity.coordinator.service import CoordinatorService
        return CoordinatorService
    if name == "CoordinatorStore":
        from openagent_identity.coordinator.store import CoordinatorStore
        return CoordinatorStore
    raise AttributeError(name)

__all__ = [
    "CoordinatorService",
    "CoordinatorStore",
    "PakeBackend",
    "Srp6aBackend",
    "LoginInProgress",
    "PakeError",
]
