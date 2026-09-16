"""Durable standalone automation grants, separate from ephemeral device access."""

from __future__ import annotations
from contextlib import asynccontextmanager
from dataclasses import asdict
import hashlib
import json
import uuid
import aiosqlite
from openagent_core.contracts import (
    ExecutionContext,
    PrincipalRef,
    ResourceRef,
    canonical_json,
    require_authorized,
)
from openagent_core.core.on_behalf_context import (
    OnBehalfIdentity,
    install_on_behalf_identity,
    reset_on_behalf_identity,
)

# Operational delivery clocks and webhook credentials never define authority.
# Every other persisted definition field is included, including unknown future
# fields, so a changed behavior cannot reuse a grant under an old digest.
_OPERATIONAL = frozenset(
    {
        "created_at",
        "updated_at",
        "last_run",
        "next_run",
        "last_run_at",
        "next_run_at",
        "last_triggered_at",
        "enabled",
        "secret_enc",
        "secret_hint",
    }
)


def definition_digest(kind, definition):
    if kind not in {"task", "event", "workflow"} or not definition.get("id"):
        raise ValueError("A known persisted automation definition is required")
    value = {
        key: value
        for key, value in definition.items()
        if key not in _OPERATIONAL and not key.startswith("_")
    }
    return hashlib.sha256(
        canonical_json({"version": 1, "kind": kind, "definition": value}).encode()
    ).hexdigest()


class NativeAutomationAuthority:
    def __init__(self, service):
        self.service = service
        self.db = service.agent.memory_db

    async def start(self):
        async with aiosqlite.connect(self.db.db_path) as conn:
            await conn.execute("""CREATE TABLE IF NOT EXISTS standalone_automation_grants (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, definition_id TEXT NOT NULL,
                digest TEXT NOT NULL, principal_json TEXT NOT NULL, audience_json TEXT NOT NULL,
                scopes_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)""")
            await conn.commit()

    @asynccontextmanager
    async def _connection(self, connection=None):
        if connection is not None:
            yield connection
        else:
            async with aiosqlite.connect(self.db.db_path) as opened:
                opened.row_factory = aiosqlite.Row
                yield opened

    async def definition(self, kind, identifier, *, connection=None):
        table = {
            "task": "scheduled_tasks",
            "event": "events",
            "workflow": "workflow_tasks",
        }.get(kind)
        if table is None:
            raise ValueError("Unknown automation kind")
        async with self._connection(connection) as conn:
            row = await (
                await conn.execute(f"SELECT * FROM {table} WHERE id=?", (identifier,))
            ).fetchone()
            if row is None:
                raise LookupError(identifier)
            return dict(row)

    async def capture(self, kind, definition, context, *, connection=None):
        await require_authorized(
            self.service.authorizer,
            context,
            "automation.manage",
            ResourceRef("automation", context.tenant_id, kind + "/" + definition["id"]),
        )
        if context.deferred or context.authority != context.initiator:
            raise PermissionError(
                "A new durable grant requires its verified initiating principal"
            )
        current = await self.definition(kind, definition["id"], connection=connection)
        digest = definition_digest(kind, definition)
        if definition_digest(kind, current) != digest:
            raise ValueError(
                "Automation changed while authorization was being captured"
            )
        if not definition.get("enabled", True):
            await self.revoke(kind, definition["id"], context, connection=connection)
            return None
        catalog = self.service.runtime.capabilities
        tools = await catalog.discover(context)
        ephemeral = {lease.source_id for lease in context.capabilities}
        sources = sorted(
            {tool.source_id for tool in tools if tool.source_id not in ephemeral}
        )
        scopes = tuple(
            sorted(set(context.scopes) | {"capability:" + source for source in sources})
        )
        identifier = str(uuid.uuid4())
        async with self._connection(connection) as conn:
            if connection is None:
                await conn.execute("BEGIN IMMEDIATE")
            await conn.execute(
                "UPDATE standalone_automation_grants SET revoked=1 WHERE kind=? AND definition_id=?",
                (kind, definition["id"]),
            )
            # Each authorization has a new ID. Reapproving a definition must
            # never reactivate a context carrying the previously revoked grant.
            await conn.execute(
                """INSERT INTO standalone_automation_grants
                (id,kind,definition_id,digest,principal_json,audience_json,scopes_json,revoked)
                VALUES (?,?,?,?,?,?,?,0)""",
                (
                    identifier,
                    kind,
                    definition["id"],
                    digest,
                    canonical_json(asdict(context.initiator)),
                    canonical_json([asdict(p) for p in context.audience]),
                    canonical_json(scopes),
                ),
            )
            if connection is None:
                await conn.commit()
        return identifier

    async def revoke(self, kind, identifier, context, *, connection=None):
        await require_authorized(
            self.service.authorizer,
            context,
            "automation.manage",
            ResourceRef("automation", context.tenant_id, kind + "/" + identifier),
        )
        async with self._connection(connection) as conn:
            await conn.execute(
                "UPDATE standalone_automation_grants SET revoked=1 WHERE kind=? AND definition_id=?",
                (kind, identifier),
            )
            if connection is None:
                await conn.commit()

    async def _grant(self, identifier):
        async with aiosqlite.connect(self.db.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            row = await (
                await conn.execute(
                    "SELECT * FROM standalone_automation_grants WHERE id=? AND revoked=0",
                    (identifier,),
                )
            ).fetchone()
            return dict(row) if row else None

    async def principal_active(self, principal):
        resolver = getattr(self.service.gateway, "runtime_principal_active", None)
        if resolver is not None:
            return bool(await resolver(principal))
        if principal.authority != "openagent":
            return False
        # Coordinator owns this directory. A member host requires the explicit
        # remote resolver instead of considering a missing local user active.
        async with aiosqlite.connect(self.db.db_path) as conn:
            role = await (
                await conn.execute(
                    "SELECT role,network_id FROM network WHERE singleton=1"
                )
            ).fetchone()
            if (
                role is None
                or role[0] != "coordinator"
                or role[1] != principal.tenant_id
            ):
                return False
            if principal.kind == "user":
                row = await (
                    await conn.execute(
                        "SELECT status FROM network_users WHERE handle=?",
                        (principal.subject_id,),
                    )
                ).fetchone()
                return bool(row and row[0] == "active")
            if principal.kind == "agent":
                row = await (
                    await conn.execute(
                        "SELECT 1 FROM network_agents WHERE handle=?",
                        (principal.subject_id,),
                    )
                ).fetchone()
                return row is not None
        return False

    async def resolve(self, kind, definition, occurrence_id, session_id):
        if not occurrence_id:
            raise ValueError("An existing durable occurrence ID is required")
        digest = definition_digest(kind, definition)
        async with aiosqlite.connect(self.db.db_path) as conn:
            row = await (
                await conn.execute(
                    "SELECT id FROM standalone_automation_grants WHERE kind=? AND definition_id=? AND digest=? AND revoked=0",
                    (kind, definition["id"], digest),
                )
            ).fetchone()
        if row is None:
            raise PermissionError(
                "This automation revision has no active durable authorization"
            )
        grant = await self._grant(row[0])
        principal = PrincipalRef(**json.loads(grant["principal_json"]))
        context = ExecutionContext(
            author=PrincipalRef(
                "openagent", principal.tenant_id, self.service.agent.name, "agent"
            ),
            initiator=principal,
            authority=principal,
            session_id=session_id,
            agent_id=self.service.agent.name,
            audience=tuple(
                PrincipalRef(**p) for p in json.loads(grant["audience_json"])
            ),
            scopes=tuple(json.loads(grant["scopes_json"])),
            delegation_id=grant["id"],
            deferred=True,
        )
        if not await self.validate(context):
            raise PermissionError("Automation authority changed")
        return context

    async def validate(self, context):
        if not context.delegation_id or context.capabilities or context.ingress_id:
            return False
        grant = await self._grant(context.delegation_id)
        if grant is None:
            return False
        principal = PrincipalRef(**json.loads(grant["principal_json"]))
        if context.authority != principal or context.initiator != principal:
            return False
        if context.audience != tuple(
            PrincipalRef(**p) for p in json.loads(grant["audience_json"])
        ):
            return False
        if not set(context.scopes).issubset(json.loads(grant["scopes_json"])):
            return False
        try:
            current = await self.definition(grant["kind"], grant["definition_id"])
        except LookupError:
            return False
        return (
            bool(current.get("enabled", True))
            and definition_digest(grant["kind"], current) == grant["digest"]
            and await self.principal_active(principal)
        )

    def identity(self, context):
        principal = context.authority
        return OnBehalfIdentity(
            principal.tenant_id,
            principal.kind,
            principal.subject_id,
            "delegation:" + context.delegation_id,
            "delegation",
        )

    @asynccontextmanager
    async def execution_scope(self, context):
        if not await self.validate(context):
            raise PermissionError("Automation delegation is revoked")
        token = install_on_behalf_identity(self.identity(context))
        try:
            yield
        finally:
            reset_on_behalf_identity(token)
