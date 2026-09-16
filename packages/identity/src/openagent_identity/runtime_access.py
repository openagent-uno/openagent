"""Native certificate aliases for canonical runtime and legacy product ACLs."""

from dataclasses import replace
from openagent_core.contracts import PrincipalRef
from openagent_core.memory.operational.access import AccessContext as CoreAccessContext


class AccessContext(CoreAccessContext):
    @classmethod
    def _canonical(cls, access):
        principal = PrincipalRef(
            "openagent", access.tenant_id, access.handle, access.principal_type
        )
        return replace(
            access,
            principal_ids=access.principal_ids | {principal.key},
            grant_identities=access.grant_identities
            | {(principal.kind, principal.key)},
        )

    @classmethod
    def from_request(cls, request):
        # The certificate comes only from authenticated gateway middleware;
        # a shared HTTP token has no user identity to attach to a run or ACL.
        if request.get("auth_kind") not in {"device_cert", "agent"}:
            raise PermissionError("A verified native certificate is required")
        return cls._canonical(super().from_request(request))

    @classmethod
    def from_on_behalf_identity(cls, identity):
        return cls._canonical(super().from_on_behalf_identity(identity))
