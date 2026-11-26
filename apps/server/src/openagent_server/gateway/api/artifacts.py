"""Authenticated upload and download endpoints for durable attachments.

The gateway is the only public surface of OpenAgent, so clients and bridges
never receive a raw content-store route.  Uploads become canonical artifact
rows immediately; downloads re-check the artifact/session ACL before reading
the content-addressed bytes.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
import hashlib
import os
from pathlib import Path
import tempfile
from typing import Any, BinaryIO

from aiohttp import web
from aiohttp.helpers import content_disposition_header

from openagent_core.memory.artifacts import (
    ArtifactIntegrityError,
    ArtifactNotFound,
    AttachmentTooLarge,
    artifact_authorized_metadata,
    artifact_authorized_row,
    attachment_limit_bytes,
    normalize_inbound_attachments,
    public_attachment_ref,
    safe_attachment_filename,
)
from openagent_identity.runtime_access import AccessContext

from ._common import gateway_db


def _problem(status: int, code: str, message: str) -> web.Response:
    return web.json_response(
        {
            "error": {
                "code": code,
                "message": message,
                "retryable": status in {429, 503},
            }
        },
        status=status,
        headers={"Cache-Control": "no-store"},
    )


def _public_ref(ref: dict[str, Any]) -> dict[str, Any]:
    """Canonical upload response; new clients never receive a local path."""

    return public_attachment_ref(ref)


async def normalize_turn_attachments(db, attachments, *, session_id, principal, allow_local_paths=False):
    """Resolve references and recheck their linked sessions before turn admission."""
    refs = await normalize_inbound_attachments(
        db, attachments, session_id=session_id, principal=principal, allow_local_paths=allow_local_paths,
    )
    projection = getattr(principal, "projection", None)
    if projection is not None:
        try:
            await projection.recheck(resolve_connection=db._ensure_connected)
        except PermissionError:
            raise ArtifactNotFound("Attachment is not available") from None
    return refs


async def _read_form(request: web.Request) -> tuple[Path, dict[str, str]]:
    """Stream one multipart file to a bounded staging path."""

    if not request.content_type.startswith("multipart/"):
        raise ValueError("multipart form-data is required")
    limit = attachment_limit_bytes(direction="input")
    content_length = request.content_length
    # Multipart framing adds a little overhead.  This is only an early reject;
    # the byte counter below remains authoritative.
    if limit and content_length is not None and content_length > limit + 1024 * 1024:
        raise AttachmentTooLarge(content_length, limit)

    reader = await request.multipart()
    staged: Path | None = None
    metadata: dict[str, str] = {}
    try:
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.filename is not None and staged is None:
                filename = safe_attachment_filename(field.filename)
                suffix = Path(filename).suffix[:24]
                fd, raw_path = tempfile.mkstemp(prefix="oa-artifact-", suffix=suffix)
                staged = Path(raw_path)
                size = 0
                declared_mime = str(field.headers.get("Content-Type") or "").strip()
                if declared_mime:
                    metadata["mime_type"] = declared_mime
                metadata["filename"] = filename
                try:
                    with os.fdopen(fd, "wb") as out:
                        while True:
                            chunk = await field.read_chunk(size=64 * 1024)
                            if not chunk:
                                break
                            size += len(chunk)
                            if limit and size > limit:
                                raise AttachmentTooLarge(size, limit)
                            out.write(chunk)
                        out.flush()
                        os.fsync(out.fileno())
                except Exception:
                    with suppress(OSError):
                        os.close(fd)
                    raise
                continue
            # Metadata fields are deliberately tiny.  Unknown multipart
            # payloads are consumed but never copied into the response.
            if field.name in {"session_id", "filename", "mime_type", "kind"}:
                raw = await field.read(decode=True)
                if len(raw) > 4096:
                    raise ValueError(f"{field.name} is too long")
                metadata[str(field.name)] = raw.decode("utf-8", errors="replace").strip()
            else:
                while await field.read_chunk(size=4096):
                    pass
        if staged is None:
            raise ValueError("file is required")
        return staged, metadata
    except BaseException:
        if staged is not None:
            with suppress(OSError):
                staged.unlink()
        raise


async def handle_upload(request: web.Request) -> web.Response:
    """``POST /api/artifacts`` — persist one upload and return AttachmentRef."""

    try:
        access = AccessContext.from_request(request)
    except PermissionError:
        return _problem(401, "unauthorized", "Authentication is required")
    db = gateway_db(request)
    if db is None:
        return _problem(501, "unsupported", "Artifact storage is unavailable")
    staged: Path | None = None
    try:
        staged, metadata = await _read_form(request)
        filename = safe_attachment_filename(
            metadata.get("filename") or staged.name,
        )
        session_id = str(
            metadata.get("session_id") or request.query.get("session_id") or ""
        ).strip()
        raw = {
            "path": str(staged),
            "filename": filename,
            "mime_type": metadata.get("mime_type") or None,
            "kind": metadata.get("kind") or request.query.get("kind") or "file",
        }
        refs = await normalize_inbound_attachments(
            db,
            (raw,),
            session_id=session_id,
            principal=access,
            # ``staged`` was created by this handler and populated only from
            # the bounded multipart body; it is not a client-supplied host path.
            allow_local_paths=True,
        )
        if not refs:
            return _problem(400, "invalid_attachment", "The upload could not be stored")
        return web.json_response(
            {"attachment": _public_ref(refs[0])},
            status=201,
            headers={"Cache-Control": "no-store"},
        )
    except AttachmentTooLarge as exc:
        return _problem(
            413,
            "attachment_too_large",
            f"Attachment exceeds the {exc.limit_bytes}-byte limit",
        )
    except (ValueError, UnicodeError) as exc:
        return _problem(400, "invalid_attachment", str(exc))
    except (OSError, ArtifactNotFound):
        return _problem(400, "invalid_attachment", "The upload could not be read")
    finally:
        if staged is not None:
            with suppress(OSError):
                staged.unlink()


async def handle_metadata(request: web.Request) -> web.Response:
    """``GET /api/artifacts/{id}`` — ACL-filtered canonical metadata."""

    return await _read_artifact(request, include_content=False)


async def handle_content(request: web.Request) -> web.Response:
    """``GET /api/artifacts/{id}/content`` — ACL-filtered bytes."""

    return await _read_artifact(request, include_content=True)


async def verified_download(db, row, path: Path, access) -> tuple[dict, BinaryIO]:
    """Return the exact verified bytes and current presentation metadata."""
    block_size = 256 * 1024
    snapshot = tempfile.SpooledTemporaryFile(max_size=block_size, mode="w+b")
    try:
        size = int(row["size_bytes"])
        digest = hashlib.sha256()
        copied = 0
        with path.open("rb") as source:
            while chunk := await asyncio.to_thread(source.read, block_size):
                copied += len(chunk)
                if copied > size:
                    raise ArtifactIntegrityError(row["id"])
                digest.update(chunk)
                await asyncio.to_thread(snapshot.write, chunk)
        if copied != size or digest.hexdigest() != row["sha256"]:
            raise ArtifactIntegrityError(row["id"])
        current = await artifact_authorized_metadata(db, row["id"], access)
        if current["sha256"] != row["sha256"] or int(current["size_bytes"]) != size:
            raise ArtifactIntegrityError(row["id"])
        snapshot.seek(0)
        return current, snapshot
    except BaseException:
        snapshot.close()
        raise


def download_response(
    request: web.Request, snapshot: BinaryIO, size: int, mime: str, headers: dict[str, str],
) -> web.Response:
    """Give aiohttp ownership of a chunked file payload after normal middleware."""
    headers["Content-Length"] = str(size)
    if request.method == "HEAD":
        snapshot.close()
        return web.Response(content_type=mime, headers=headers)
    try:
        return web.Response(body=snapshot, content_type=mime, headers=headers)
    except BaseException:
        snapshot.close()
        raise


async def _read_artifact(
    request: web.Request,
    *,
    include_content: bool,
) -> web.Response:
    try:
        access = AccessContext.from_request(request)
    except PermissionError:
        return _problem(401, "unauthorized", "Authentication is required")
    db = gateway_db(request)
    if db is None:
        return _problem(501, "unsupported", "Artifact storage is unavailable")
    artifact_id = str(request.match_info.get("artifact_id") or "").strip()
    if not artifact_id:
        # Do not reveal whether an inaccessible id exists.
        return _problem(404, "artifact_not_found", "Artifact is not available")
    try:
        row, path = await artifact_authorized_row(db, artifact_id, access)
    except ArtifactIntegrityError:
        return _problem(503, "artifact_unavailable", "Artifact bytes failed integrity checks")
    except ArtifactNotFound:
        return _problem(404, "artifact_not_found", "Artifact is not available")
    if not include_content:
        try:
            row = await artifact_authorized_metadata(db, artifact_id, access)
        except ArtifactNotFound:
            return _problem(404, "artifact_not_found", "Artifact is not available")
        return web.json_response(
            {
                "artifact": {
                    "artifact_id": artifact_id,
                    "kind": row["kind"],
                    "filename": row["authorized_filename"],
                    "mime_type": row["mime"],
                    "size_bytes": row["size_bytes"],
                    "sha256": row["sha256"],
                    "url": f"/api/artifacts/{artifact_id}/content",
                }
            },
            headers={"Cache-Control": "no-store"},
        )

    size = int(row["size_bytes"])
    limit = attachment_limit_bytes(direction="output")
    if limit and size > limit:
        return _problem(413, "artifact_too_large", "Artifact is too large to serve")
    try:
        row, snapshot = await verified_download(db, row, path, access)
    except ArtifactIntegrityError:
        return _problem(503, "artifact_unavailable", "Artifact bytes failed integrity checks")
    except ArtifactNotFound:
        return _problem(404, "artifact_not_found", "Artifact is not available")
    except (MemoryError, OSError):
        return _problem(503, "artifact_unavailable", "Artifact bytes are unavailable")
    filename = safe_attachment_filename(row["authorized_filename"] or artifact_id)
    headers = {
        "Cache-Control": "private, no-store",
        "Content-Disposition": content_disposition_header(
            "inline" if str(row["kind"]) in {"image", "voice", "video"} else "attachment",
            filename=filename,
        ),
        "X-Content-Type-Options": "nosniff",
        "ETag": f'"sha256-{row["sha256"]}"',
    }
    return download_response(request, snapshot, size, str(row["mime"] or "application/octet-stream"), headers)


__all__ = ["handle_content", "handle_metadata", "handle_upload"]
