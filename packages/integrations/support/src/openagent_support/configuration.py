"""Host-owned support policy and authenticated routing, with no default tenant."""
from __future__ import annotations

from dataclasses import dataclass, field
import math
from types import MappingProxyType
from typing import Any, Mapping


class SupportConfigurationError(ValueError):
    """The host did not supply a complete, explicit support configuration."""


class SupportAuthorizationError(PermissionError):
    """A requested operation is outside the authenticated host binding."""


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise SupportConfigurationError("Support identities require nonempty exact strings")
    return value


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise SupportConfigurationError("Support configuration keys must be strings")
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, float) and not math.isfinite(value):
        raise SupportConfigurationError("Support configuration numbers must be finite")
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise SupportConfigurationError("Support configuration must contain JSON values")


@dataclass(frozen=True, slots=True)
class SupportIdentity:
    """Created by trusted host code from authenticated grants, never user payload."""
    authority_id: str
    tenant_id: str
    profile_id: str

    def __post_init__(self) -> None:
        for value in (self.authority_id, self.tenant_id, self.profile_id):
            _identifier(value)


@dataclass(frozen=True, slots=True)
class SupportProfile:
    identity: SupportIdentity
    event_slugs: tuple[str, ...] = ()
    operations: tuple[str, ...] = ()
    tool_bindings: Mapping[str, str] = field(default_factory=dict)
    policy: Mapping[str, Any] = field(default_factory=dict)
    options: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.identity, SupportIdentity):
            raise SupportConfigurationError("A profile requires an authenticated identity binding")
        for name in self.event_slugs:
            _identifier(name)
        if any(name not in {"event", "quality_scorer", "quality_digest"} for name in self.operations):
            raise SupportConfigurationError("Unknown support operation")
        if any(not isinstance(value, Mapping) for value in (self.tool_bindings, self.policy, self.options)):
            raise SupportConfigurationError("Support tool bindings, policy and options must be mappings")
        for name, destination in self.tool_bindings.items():
            _identifier(name)
            _identifier(destination)
        for name in ("event_slugs", "operations"):
            object.__setattr__(self, name, tuple(getattr(self, name)))
        for name in ("tool_bindings", "policy", "options"):
            object.__setattr__(self, name, _freeze(getattr(self, name)))


@dataclass(frozen=True, slots=True)
class SupportConfiguration:
    profiles: tuple[SupportProfile, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "profiles", tuple(self.profiles))
        if any(not isinstance(profile, SupportProfile) for profile in self.profiles):
            raise SupportConfigurationError("Support profiles must be typed host configuration")
        identities = [profile.identity for profile in self.profiles]
        if len(set(identities)) != len(identities):
            raise SupportConfigurationError("Duplicate support identity binding")

    def resolve(self, identity: SupportIdentity) -> SupportProfile:
        if not isinstance(identity, SupportIdentity):
            raise SupportAuthorizationError("The host did not return a verified support identity")
        for profile in self.profiles:
            if profile.identity == identity:
                return profile
        raise SupportAuthorizationError("No support profile is authorized for this host identity")
