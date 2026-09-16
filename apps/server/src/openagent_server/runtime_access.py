"""Standalone identity adapter for the transport-independent runtime.

Authentication remains in the product's certificate middleware. This adapter
stores only trusted in-memory request bindings, never bearer credentials in a
run snapshot, and reads current canonical ACLs before each authorization.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

import aiosqlite

from openagent_core.contracts import ExecutionContext, PrincipalRef, ResourceRef
from openagent_core.core.on_behalf_context import OnBehalfIdentity
from openagent_identity.runtime_access import AccessContext
from openagent_core.memory.operational.access import resource_is_visible

SourceAuthorizer = Callable[..., Awaitable[bool]]


@dataclass(frozen=True)
class _Binding:
    identity: OnBehalfIdentity
    request: Any
    certificate: Any


class _TrustedRequest(dict):
    def __init__(self, request: Any):
        super().__init__(
            (name, request.get(name))
            for name in (
                "device_cert",
                "network_id",
                "user_handle",
                "client_id",
                "auth_kind",
                "device_auth_epoch",
            )
        )
        self.app = request.app


def _principal(value: str | None, tenant: str) -> PrincipalRef | None:
    if not value:
        return None
    try:
        record = json.loads(value)
        if isinstance(record, dict):
            principal = PrincipalRef(**record)
            return principal if principal.tenant_id == tenant else None
    except (ValueError, TypeError):
        pass
    kind, separator, subject = value.partition(":")
    if separator and kind in {"user", "agent"} and subject:
        return PrincipalRef("openagent", tenant, subject, kind)
    return None


class NativeRuntimeAuthorizer:
    def __init__(
        self,
        gateway: Any,
        db_path: str | Path,
        source_authorizer: SourceAuthorizer | None = None,
    ):
        self.gateway = gateway
        self.db_path = Path(db_path).resolve()
        self.source_authorizer = source_authorizer
        self.delegations = None
        self.memory_authorizer = None
        self._bindings: dict[str, _Binding] = {}
        self._identity_bindings: dict[str, str] = {}

    @staticmethod
    def binding_id(identity: OnBehalfIdentity) -> str:
        material = json.dumps(
            (
                identity.tenant_id,
                identity.principal_type,
                identity.handle,
                identity.device_id,
            )
        )
        return hashlib.sha256(material.encode()).hexdigest()

    async def bind_request(self, request: Any) -> OnBehalfIdentity:
        if request.get("auth_kind") not in {"device_cert", "agent"}:
            raise PermissionError(
                "Runtime execution requires a verified principal, not a shared HTTP token"
            )
        cert = request.get("device_cert")
        identity = OnBehalfIdentity.from_certificate(
            cert,
            auth_kind=str(request.get("auth_kind") or ""),
        )
        if not await self.gateway._request_device_still_authorized(request, cert):
            raise PermissionError("Device authorization changed")
        identity_id = self.binding_id(identity)
        ingress_id = hashlib.sha256(
            f"{identity_id}:{request.get('device_auth_epoch', 0)}".encode()
        ).hexdigest()
        self._bindings[ingress_id] = _Binding(identity, _TrustedRequest(request), cert)
        self._identity_bindings[identity_id] = ingress_id
        return identity

    async def _binding(self, context: ExecutionContext) -> _Binding | None:
        binding = self._bindings.get(context.ingress_id or "")
        if binding is None:
            return None
        identity = binding.identity
        if (
            context.authority != context.initiator
            or context.initiator.authority != "openagent"
            or context.initiator.tenant_id != identity.tenant_id
            or context.initiator.subject_id != identity.handle
            or context.initiator.kind != identity.principal_type
        ):
            return None
        if not await self.gateway._request_device_still_authorized(
            binding.request, binding.certificate
        ):
            return None
        return binding

    def _connection(self):
        # Read-only product policy connection; runtime owns all run mutations.
        return aiosqlite.connect(self.db_path.as_uri() + "?mode=ro", uri=True)

    @staticmethod
    async def _session(connection: Any, session_id: str):
        return await (
            await connection.execute(
                "SELECT id AS resource_id, 'session' AS resource_type, tenant_id, "
                "owner_principal_id, visibility, acl_version FROM sessions_v2 "
                "WHERE id=? AND deleted_at_ms IS NULL",
                (session_id,),
            )
        ).fetchone()

    async def _audience(
        self, connection: Any, row: Any, principal: PrincipalRef
    ) -> tuple[PrincipalRef, ...]:
        if row is None:
            return (principal,)
        tenant = row["tenant_id"]
        owner = _principal(row["owner_principal_id"], tenant)
        if owner is None:
            raise PermissionError("Historical session owner needs explicit resolution")
        recipients = {owner.key: owner}
        grants = await (
            await connection.execute(
                "SELECT principal_type, principal_id FROM resource_acl WHERE tenant_id=? "
                "AND resource_type='session' AND resource_id=? AND acl_version=? "
                "AND permission IN ('view','admin')",
                (tenant, row["resource_id"], row["acl_version"]),
            )
        ).fetchall()
        for grant in grants:
            kind, identifier = grant["principal_type"], grant["principal_id"]
            if kind in {"user", "agent"}:
                recipient = _principal(identifier, tenant) or PrincipalRef(
                    "openagent", tenant, identifier, kind
                )
                recipients[recipient.key] = recipient
            else:
                # Device and installation grants need the same host directory
                # expansion as shared visibility, rather than a guessed owner.
                return await self._expanded_audience(connection, row, recipients)
        if row["visibility"] in {"installation_shared", "public"}:
            return await self._expanded_audience(connection, row, recipients)
        return tuple(recipients[key] for key in sorted(recipients))

    async def _expanded_audience(
        self, connection: Any, row: Any, recipients: dict[str, PrincipalRef]
    ) -> tuple[PrincipalRef, ...]:
        resolver = getattr(self.gateway, "runtime_audience_resolver", None)
        if resolver is None:
            raise PermissionError(
                "Shared or device-granted sessions require an explicit audience resolver"
            )
        values = await resolver(row["resource_id"], row["tenant_id"])
        for principal in values:
            if (
                not isinstance(principal, PrincipalRef)
                or principal.tenant_id != row["tenant_id"]
            ):
                raise PermissionError("Invalid result audience")
            recipients[principal.key] = principal
        return tuple(recipients[key] for key in sorted(recipients))

    async def context_for_identity(
        self, identity: OnBehalfIdentity, session_id: str, *, capabilities: tuple = ()
    ) -> ExecutionContext:
        ingress_id = self._identity_bindings.get(self.binding_id(identity))
        binding = self._bindings.get(ingress_id or "")
        if binding is None or binding.identity != identity:
            raise PermissionError("No verified ingress binding for this principal")
        principal = PrincipalRef(
            "openagent", identity.tenant_id, identity.handle, identity.principal_type
        )
        async with self._connection() as connection:
            connection.row_factory = aiosqlite.Row
            row = await self._session(connection, session_id)
            if row is not None and row["tenant_id"] != principal.tenant_id:
                raise PermissionError("Session belongs to a different tenant")
            audience = await self._audience(connection, row, principal)
        return ExecutionContext(
            author=principal,
            initiator=principal,
            authority=principal,
            session_id=session_id,
            agent_id=self.gateway.agent.name,
            audience=audience,
            capabilities=capabilities,
            ingress_id=ingress_id,
        )

    async def authorize(
        self,
        context: ExecutionContext,
        action: str,
        resource: ResourceRef,
        *,
        audience: tuple[PrincipalRef, ...] = (),
    ) -> bool:
        binding = None
        if context.delegation_id:
            if self.delegations is None or not await self.delegations.validate(context):
                return False
            identity = self.delegations.identity(context)
        else:
            binding = await self._binding(context)
            if binding is None:
                return False
            identity = binding.identity
        if resource.tenant_id != context.tenant_id:
            return False
        if action.startswith("memory."):
            return bool(
                self.memory_authorizer is not None
                and await self.memory_authorizer(
                    context, action, resource, audience=audience
                )
            )
        if resource.kind != "session":
            if self.source_authorizer is None:
                return False
            return bool(
                await self.source_authorizer(
                    context, action, resource, audience=audience
                )
            )
        access = AccessContext.from_on_behalf_identity(identity)
        async with self._connection() as connection:
            connection.row_factory = aiosqlite.Row
            row = await self._session(connection, resource.resource_id)
            if row is None:
                return action == "run.submit" and context.audience == (
                    context.initiator,
                )
            if row["tenant_id"] != context.tenant_id:
                return False
            # New runtime rows use fully-qualified abstract principal keys;
            # legacy rows retain their historical typed handle unchanged.
            owner = _principal(row["owner_principal_id"], context.tenant_id)
            permission = "view" if action in {"run.read", "run.replay"} else "admin"
            if owner != context.initiator and not await resource_is_visible(
                connection, row, access, permission=permission
            ):
                return False
            if action in {"run.execute", "run.publish"}:
                current = await self._audience(connection, row, context.initiator)
                if set(current) != set(context.audience):
                    return False
        return (
            await self.delegations.validate(context)
            if context.delegation_id
            else await self._binding(context) is not None
        )
