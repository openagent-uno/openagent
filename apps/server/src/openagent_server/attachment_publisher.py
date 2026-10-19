"""Explicit server-host attachment publication for the public Core sender.

The server filesystem opt-in selects this reader. It cannot select a connected
App/device, grant a different session, or broaden the configured reader roots.
"""
from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

from openagent_core.artifacts import ArtifactRepository
from openagent_core.contracts import ResourceRef, require_authorized
from openagent_core.runtime import current_execution_context, current_run_id, current_runtime


class _SessionPublicationPolicy:
    def __init__(self, publisher):
        self.publisher = publisher

    async def authorize(self, context, action, resource, *, audience=()):
        if action != "artifact.write" or resource.tenant_id != context.tenant_id or tuple(audience) != context.audience:
            return False
        if (resource.kind, resource.resource_id) not in {
            ("agent", context.agent_id), ("session", context.session_id),
        }:
            return False
        await self.publisher.authorize(context)
        return True


class ServerAttachmentPublisher:
    def __init__(self, service, reader):
        self.service, self.reader = service, reader
        self.artifacts = ArtifactRepository(service.agent.memory_db, _SessionPublicationPolicy(self))

    async def authorize(self, context):
        runtime = self.service.runtime
        run_id = current_run_id()
        if (runtime is None or current_runtime() is not runtime or
                current_execution_context() is not context or not run_id or
                context.agent_id != self.service.agent.name):
            raise PermissionError("Attachment delivery requires the current server execution")
        record = await runtime.get_run(run_id, context)
        if (record.session_id != context.session_id or record.tenant_id != context.tenant_id or record.terminal):
            raise PermissionError("Attachment delivery requires the current session run")
        await require_authorized(self.service.authorizer, context, "run.publish",
            ResourceRef("session", context.tenant_id, context.session_id), audience=context.audience)

    async def publish(self, context, path):
        await self.authorize(context)
        result = await self.reader.call("read_media_file", {"path": path})
        if result.is_error or not result.content:
            raise LookupError("The server attachment could not be read")
        block = result.content[0]
        content = base64.b64decode(block.get("data") or block["text"], validate=True)
        filename = Path(path).name
        reference = await self.artifacts.upload(context, content, filename=filename,
            mime_type=mimetypes.guess_type(filename)[0] or "application/octet-stream",
            session_id=context.session_id)
        await self.authorize(context)
        return reference


def build_attachment_publisher(service):
    from openagent_filesystem import FilesystemServer
    from openagent_server.bootstrap import _server_host_selection

    if "filesystem" not in _server_host_selection(service.agent.config):
        return None
    # Exactly the standalone host filesystem composition: bootstrap's resolver
    # launches openagent_host_tools.mcp_server in the database parent, whose
    # filesystem factory is FilesystemServer(Path.cwd()). No device is involved.
    workspace = Path(service.agent.memory_db.db_path).resolve().parent
    return ServerAttachmentPublisher(service, FilesystemServer(workspace))
