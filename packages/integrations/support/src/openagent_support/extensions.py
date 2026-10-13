"""Optional support callbacks explicitly injected by the embedding host."""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Mapping, Protocol
from openagent_core.extensions import EngineExtensions
from .configuration import (
    SupportAuthorizationError, SupportConfiguration, SupportConfigurationError,
    SupportIdentity, SupportProfile,
)


class SupportAdapter(Protocol):
    """Host plugin; its IO still uses the host's authorized public capabilities."""

    async def handle_event(self, *, profile: SupportProfile, identity: SupportIdentity,
                           agent: Any, event: Mapping[str, Any], payload: Any,
                           session_id: str, delivery_id: str) -> Any: ...

    async def handle_scheduled(self, *, profile: SupportProfile, identity: SupportIdentity,
                               operation: str, agent: Any, task: Mapping[str, Any],
                               prompt: str, session_id: str, dry_run: bool) -> Any: ...


IdentityResolver = Callable[..., Awaitable[SupportIdentity]]


def _check_selectors(value: Any, identity: SupportIdentity) -> None:
    if not isinstance(value, Mapping):
        return
    # These explicit support selectors are assertions, never authentication.
    for key, expected in (("supportProfile", identity.profile_id),
                          ("supportTenant", identity.tenant_id),
                          ("supportAuthority", identity.authority_id)):
        if key in value and value[key] != expected:
            raise SupportAuthorizationError("Support selector conflicts with the authenticated host binding")


def support_extensions(*, configuration: SupportConfiguration | None = None,
                       identity_resolver: IdentityResolver | None = None,
                       adapter: SupportAdapter | None = None,
                       content_validator=None, output_retainer=None,
                       execution_profile_selector=None) -> EngineExtensions:
    """No configuration means disabled; partial configuration fails at startup.

    The resolver must bind the actual authenticated agent/event/task grant to
    a configured identity. Event payloads and task names do not grant access.
    Plugins receive an immutable profile only after this binding is checked.
    """
    if configuration is None and identity_resolver is None and adapter is None:
        return EngineExtensions(content_validator=content_validator)
    if not isinstance(configuration, SupportConfiguration) or not callable(identity_resolver) or adapter is None:
        raise SupportConfigurationError("Support requires configuration, a trusted identity resolver and a host adapter")
    if not callable(getattr(adapter, "handle_event", None)) or not callable(getattr(adapter, "handle_scheduled", None)):
        raise SupportConfigurationError("Support adapter must implement both callback contracts")

    async def resolve(*, kind, agent, definition, session_id):
        identity = await identity_resolver(kind=kind, agent=agent, definition=definition, session_id=session_id)
        profile = configuration.resolve(identity)
        _check_selectors(definition, identity)
        return identity, profile

    async def handle_event(*, agent, event, payload, session_id, delivery_id):
        slug = event.get("slug")
        if not any(slug in profile.event_slugs for profile in configuration.profiles):
            return None
        identity, profile = await resolve(kind="event", agent=agent, definition=event, session_id=session_id)
        _check_selectors(payload, identity)
        if "event" not in profile.operations or slug not in profile.event_slugs:
            raise SupportAuthorizationError("Support event is not enabled for this identity")
        return await adapter.handle_event(profile=profile, identity=identity, agent=agent,
            event=event, payload=payload, session_id=session_id, delivery_id=delivery_id)

    async def handle_scheduled(*, agent, task, prompt, session_id, dry_run):
        operations = [operation for marker, operation in (("[[quality-digest]]", "quality_digest"),
                      ("[[quality-scorer]]", "quality_scorer")) if marker in prompt]
        if not operations:
            return None
        if len(operations) != 1:
            raise SupportConfigurationError("A support task must request exactly one operation")
        identity, profile = await resolve(kind="scheduled_task", agent=agent, definition=task, session_id=session_id)
        operation = operations[0]
        if operation not in profile.operations:
            raise SupportAuthorizationError("Support task is not enabled for this identity")
        return await adapter.handle_scheduled(profile=profile, identity=identity, operation=operation,
            agent=agent, task=task, prompt=prompt, session_id=session_id, dry_run=dry_run)

    return EngineExtensions(event_handler=handle_event, scheduled_handler=handle_scheduled,
        output_retainer=output_retainer, content_validator=content_validator,
        execution_profile_selector=execution_profile_selector)
