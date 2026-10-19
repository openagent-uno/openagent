"""Standalone REST consumes the public Core transcript and current ACLs."""

from __future__ import annotations

from contextlib import asynccontextmanager
import json
from pathlib import Path
import tempfile
from types import MethodType, SimpleNamespace
from unittest.mock import patch

from ._framework import TestContext, test


@asynccontextmanager
async def _fixture():
    from openagent_core.memory.db import MemoryDB
    from openagent_server.runtime_access import NativeRuntimeAuthorizer
    from openagent_server.runtime_service import NativeRuntimeService

    with tempfile.TemporaryDirectory(prefix="oa-public-transcript-") as raw:
        db = MemoryDB(str(Path(raw) / "agent.db"))
        await db.connect()
        try:
            conn = await db._ensure_connected()
            await conn.execute(
                "INSERT INTO network(singleton,role,network_id,name,created_at) "
                "VALUES(1,'coordinator','transcript-tenant','Synthetic QA',1) "
                "ON CONFLICT(singleton) DO UPDATE SET network_id=excluded.network_id"
            )
            await conn.commit()
            await db.upsert_session("session", client_id="alice", title="Synthetic QA")
            run = {
                "run_id": "legacy-display-run", "status": "COMPLETED", "created_at": 1,
                "messages": [
                    {"role": "user", "content": "Read the synthetic report"},
                    {"role": "assistant", "content": "Synthetic reply"},
                ],
            }
            await conn.execute("UPDATE sessions SET runs=? WHERE session_id='session'", (json.dumps([run]),))
            await db._project_operational_session("session")
            await conn.commit()

            class Gateway:
                allowed = True

                async def _request_device_still_authorized(self, request, certificate):
                    return self.allowed

            gateway = Gateway()
            gateway.agent = SimpleNamespace(name="synthetic-agent", memory_db=db)
            service = SimpleNamespace(runtime=object(), agent=gateway.agent)
            service.authorizer = NativeRuntimeAuthorizer(gateway, db.db_path)
            service.context = MethodType(NativeRuntimeService.context, service)
            gateway.runtime_service = service

            class Request(dict):
                def __init__(self, handle="alice", *, session="session", query=None):
                    certificate = SimpleNamespace(network_id="transcript-tenant", handle=handle,
                        device_pubkey_hex=handle + "-device", capabilities=[])
                    super().__init__(auth_kind="device_cert", device_cert=certificate,
                        network_id="transcript-tenant", user_handle=handle,
                        client_id=certificate.device_pubkey_hex)
                    self.app = {"gateway": gateway}
                    self.match_info = {"session_id": session}
                    self.query = query or {}

            yield db, conn, gateway, Request
        finally:
            await db.close()


@test("session_public_projection", "legacy route uses public Core projection instead of a host copy")
async def t_public_projection_route(ctx: TestContext) -> None:
    from openagent_server.gateway.api import sessions

    async with _fixture() as (_db, _conn, _gateway, request):
        with patch.object(sessions, "_expand_run_messages", side_effect=AssertionError("host projection called")):
            response = await sessions.handle_get_runs(request(query={"limit": "1"}))
        assert response.status == 200, response.text
        result = json.loads(response.text)
        assert result["session_id"] == "session"
        assert [(m["role"], m["text"]) for m in result["messages"]] == [
            ("user", "Read the synthetic report"), ("assistant", "Synthetic reply"),
        ]


@test("session_public_projection", "view grants read through Core but revoked and missing sessions stay hidden")
async def t_public_projection_view_grant(ctx: TestContext) -> None:
    from openagent_server.gateway.api import sessions

    async with _fixture() as (_db, conn, _gateway, request):
        hidden = await sessions.handle_get_runs(request("bob"))
        missing = await sessions.handle_get_runs(request("bob", session="missing"))
        assert hidden.status == missing.status == 404
        assert hidden.text == missing.text
        await conn.execute(
            "INSERT INTO resource_acl(tenant_id,resource_type,resource_id,principal_type,"
            "principal_id,permission,acl_version,granted_by_principal_id,granted_at_ms) "
            "VALUES('transcript-tenant','session','session','user','bob','view',1,'user:alice',1)"
        )
        await conn.commit()
        visible = await sessions.handle_get_runs(request("bob"))
        assert visible.status == 200, visible.text
        assert len(json.loads(visible.text)["messages"]) == 2
        await conn.execute("DELETE FROM resource_acl WHERE resource_id='session'")
        await conn.commit()
        revoked = await sessions.handle_get_runs(request("bob"))
        assert revoked.status == 404 and revoked.text == missing.text


@test("session_public_projection", "device revocation during projection never publishes the loaded transcript")
async def t_public_projection_late_revocation(ctx: TestContext) -> None:
    from openagent_server.gateway.api import sessions

    async with _fixture() as (db, _conn, gateway, request):
        original = db.list_session_runs

        async def read_then_revoke(*args, **kwargs):
            rows = await original(*args, **kwargs)
            gateway.allowed = False
            return rows

        with patch.object(db, "list_session_runs", side_effect=read_then_revoke):
            response = await sessions.handle_get_runs(request())
        assert response.status == 404, response.text
        assert "Synthetic reply" not in response.text


@test("session_public_projection", "unavailable runtime fails closed without a duplicate history fallback")
async def t_public_projection_runtime_missing(ctx: TestContext) -> None:
    from openagent_server.gateway.api import sessions

    async with _fixture() as (_db, _conn, gateway, request):
        gateway.runtime_service = None
        response = await sessions.handle_get_runs(request())
        assert response.status == 503
        assert "Synthetic reply" not in response.text

