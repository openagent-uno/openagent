"""Host-selected publication with the real Core CAS and current session ACLs."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from ._framework import TestContext, test
from .test_session_public_projection import _fixture


async def _setup(gateway, request):
    from openagent_core.contracts import RunRecord, ResourceRef, require_authorized
    from openagent_server.attachment_publisher import ServerAttachmentPublisher
    from openagent_filesystem import FilesystemServer

    service = gateway.runtime_service
    service.agent.config = {}
    context = await service.context(request(), "session")
    record = RunRecord("attachment-run", "session", context.tenant_id, "running", "synthetic")

    async def get_run(run_id, actor):
        assert run_id == record.run_id
        await require_authorized(service.authorizer, actor, "run.read",
            ResourceRef("session", actor.tenant_id, record.session_id), audience=actor.audience)
        return record

    service.runtime = SimpleNamespace(get_run=get_run)
    workspace = Path(service.agent.memory_db.db_path).parent / "workspace"
    workspace.mkdir()
    publisher = ServerAttachmentPublisher(service, FilesystemServer(workspace, allowed_roots=[workspace]))
    return service, context, record, workspace, publisher


@test("attachment_publisher", "server sender publishes file/image/video/audio through the selected bounded reader")
async def t_server_attachment_publisher_media(ctx: TestContext) -> None:
    from openagent_core.runtime import execution_scope
    async with _fixture() as (db, _conn, gateway, request):
        service, context, record, workspace, publisher = await _setup(gateway, request)
        for filename, content, mime in (
            ("report.csv", b"total\n12\n", "text/csv"),
            ("image.png", b"\x89PNG\r\n\x1a\nsynthetic", "image/png"),
            ("clip.mp4", b"synthetic-video", "video/mp4"),
            ("voice.wav", b"RIFFsynthetic-audio", "audio/x-wav"),
        ):
            (workspace / filename).write_bytes(content)
            with execution_scope(service.runtime, context, record.run_id):
                ref = await publisher.publish(context, filename)
            assert ref["filename"] == filename and ref["mime_type"] == mime, ref
            # Public Core reader with this test's explicitly scoped read policy.
            from openagent_core.artifacts import ArtifactRepository
            class ReadPolicy:
                async def authorize(self, actor, action, resource, **kwargs):
                    return action == "artifact.read" and actor is context
            stored = await ArtifactRepository(db, ReadPolicy()).read(context, artifact_id=ref["artifact_id"])
            assert stored.content == content and stored.filename == filename


@test("attachment_publisher", "disabled filesystem gives no publisher; selected reader keeps its original roots")
async def t_server_attachment_publisher_disabled_and_roots(ctx: TestContext) -> None:
    from openagent_core.runtime import execution_scope
    from openagent_server.attachment_publisher import build_attachment_publisher
    async with _fixture() as (_db, _conn, gateway, request):
        service, context, record, workspace, publisher = await _setup(gateway, request)
        for config in ({"server_host_tools": False}, {"server_host_tools": {"tools": ["shell"]}}):
            service.agent.config = config
            assert build_attachment_publisher(service) is None
        service.agent.config = {"server_host_tools": {"tools": ["filesystem"]}}
        assert build_attachment_publisher(service) is not None
        (workspace.parent / "outside.csv").write_bytes(b"outside")
        with execution_scope(service.runtime, context, record.run_id):
            try:
                await publisher.publish(context, "../outside.csv")
            except Exception as exc:
                from openagent_tool_protocol.types import HostError
                assert isinstance(exc, LookupError)
                assert isinstance(exc.__cause__, HostError) and exc.__cause__.code == "access_denied"
                assert "outside.csv" not in str(exc)
            else:
                raise AssertionError("Reader roots were bypassed")


@test("attachment_publisher", "admitted tool pixels publish without reading host files and honor revocation")
async def t_server_attachment_publisher_content(ctx: TestContext) -> None:
    from openagent_core.runtime import execution_scope
    async with _fixture() as (_db, _conn, gateway, request):
        service, context, record, workspace, publisher = await _setup(gateway, request)
        async def forbidden(*_args, **_kwargs):
            raise AssertionError("Admitted image bytes must not read the filesystem")
        publisher.reader.call = forbidden
        with execution_scope(service.runtime, context, record.run_id):
            ref = await publisher.publish_content(context, b"image bytes", filename="screenshot.png", mime_type="image/png")
            assert ref["filename"] == "screenshot.png" and ref["size_bytes"] == 11, ref
            gateway.allowed = False
            try:
                await publisher.publish_content(context, b"private", filename="denied.png", mime_type="image/png")
            except PermissionError:
                pass
            else:
                raise AssertionError("Revoked execution published image bytes")


@test("attachment_publisher", "view-only, stale execution, different session and mid-read revocation cannot publish")
async def t_server_attachment_publisher_authority(ctx: TestContext) -> None:
    from openagent_core.runtime import execution_scope
    async with _fixture() as (_db, conn, gateway, request):
        service, context, record, workspace, publisher = await _setup(gateway, request)
        (workspace / "private.csv").write_bytes(b"private")
        await conn.execute("INSERT INTO resource_acl(tenant_id,resource_type,resource_id,principal_type,principal_id,permission,acl_version,granted_by_principal_id,granted_at_ms) VALUES('transcript-tenant','session','session','user','bob','view',1,'user:alice',1)")
        await conn.commit()
        viewer = await service.context(request("bob"), "session")
        other = replace(context, session_id="other")
        for actor, scope in ((context, None), (viewer, viewer), (other, other)):
            async def attempt():
                try:
                    await publisher.publish(actor, "private.csv")
                except (PermissionError, LookupError):
                    return
                raise AssertionError("Publication did not enforce current authority")
            if scope is None:
                await attempt()
            else:
                with execution_scope(service.runtime, scope, record.run_id):
                    await attempt()
        original = publisher.reader.call
        async def read_then_revoke(*args, **kwargs):
            value = await original(*args, **kwargs)
            gateway.allowed = False
            return value
        publisher.reader.call = read_then_revoke
        with execution_scope(service.runtime, context, record.run_id):
            try:
                await publisher.publish(context, "private.csv")
            except PermissionError:
                pass
            else:
                raise AssertionError("Revocation after the reader was ignored")
