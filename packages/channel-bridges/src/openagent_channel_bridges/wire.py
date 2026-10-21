"""Bounded channel-bridge-ipc/v1 codecs and request-local media handles.

Media bytes use bounded chunks, never host-selected filesystem paths. Handles
are useful only while the child-to-host request that created them is pending.
"""
from __future__ import annotations

import base64
from dataclasses import fields, is_dataclass
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import tempfile

from .contracts import (BridgeAttachment, BridgeCapabilities, BridgeCommandDefinition,
    BridgeCommandResult, BridgeEvent, BridgePart, BridgePickerOption, BridgeReply)

PROTOCOL = "channel-bridge-ipc/v1"
MAX_LINE = 2 * 1024 * 1024
MAX_CHUNK = 64 * 1024
MAX_ARTIFACT = 32 * 1024 * 1024
MAX_FILES = 16
MAX_SESSION_BYTES = 128 * 1024 * 1024


class WireError(ValueError):
    """A closed, safe protocol rejection; never includes a received value."""


def identifier(value):
    if (not isinstance(value, str) or not value or len(value.encode()) > 128
            or any(ord(c) < 33 or ord(c) > 126 for c in value)):
        raise WireError("invalid_identifier")
    return value


def object_fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise WireError("invalid_fields")
    return value


def _budget(value, depth=0, remaining=None):
    remaining = remaining if remaining is not None else [20_000]
    remaining[0] -= 1
    if remaining[0] < 0 or depth > 32:
        raise WireError("metadata_limit")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise WireError("invalid_fields")
            _budget(item, depth + 1, remaining)
    elif isinstance(value, list):
        for item in value:
            _budget(item, depth + 1, remaining)


def decode_line(line: bytes):
    if not isinstance(line, bytes) or len(line) > MAX_LINE or not line.endswith(b"\n"):
        raise WireError("invalid_line")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise WireError("duplicate_field")
            result[key] = value
        return result
    try:
        value = json.loads(line, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(WireError("invalid_number")))
        _budget(value)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise WireError("invalid_json") from exc
    if not isinstance(value, dict) or value.get("protocol") != PROTOCOL:
        raise WireError("invalid_protocol")
    return value


def encode_line(value):
    _budget(value)
    try:
        line = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode() + b"\n"
    except (ValueError, TypeError, RecursionError) as exc:
        raise WireError("invalid_metadata") from exc
    if len(line) > MAX_LINE:
        raise WireError("metadata_limit")
    return line


def _integer(value, maximum):
    if type(value) is not int or not 0 <= value <= maximum:
        raise WireError("invalid_integer")
    return value


def _digest(value):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise WireError("invalid_sha256")
    return value


class ArtifactStore:
    """Only this runner's private staging; no host pathname is accepted.

    Input files remain pinned by an open descriptor. Provider-owned inputs are
    removed after their request only if device/inode still match. Output files
    remain until runner shutdown so the provider can deliver the reply after
    the host request has returned; their reader refs expire with that request.
    """
    def __init__(self):
        self._directory = tempfile.TemporaryDirectory(prefix="oa-channel-ipc-")
        os.chmod(self._directory.name, 0o700)
        self._scopes = {}
        self._retained = {}
        self._total = 0

    def begin(self, request_id):
        identifier(request_id)
        if request_id in self._scopes:
            raise WireError("duplicate_request")
        self._scopes[request_id] = {}

    def _scope(self, request_id):
        if request_id not in self._scopes:
            raise WireError("inactive_request")
        return self._scopes[request_id]

    def _add(self, request_id, record):
        # Providers delete owned reply media after delivery. Reclaim its quota
        # without removing any file that is still awaiting platform delivery.
        for path, size in tuple(self._retained.items()):
            if not os.path.lexists(path):
                self._total -= size
                del self._retained[path]
        scope = self._scope(request_id)
        if len(scope) >= MAX_FILES or self._total + record["size"] > MAX_SESSION_BYTES:
            raise WireError("artifact_limit")
        ref = secrets.token_urlsafe(24)
        scope[ref] = record
        self._total += record["size"]
        return ref

    def register(self, request_id, attachment):
        if not attachment.local_path:
            raise WireError("input_artifact_unavailable")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        initial = os.lstat(attachment.local_path)
        if not stat.S_ISREG(initial.st_mode):
            raise WireError("invalid_artifact")
        fd = os.open(attachment.local_path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARTIFACT:
                raise WireError("artifact_limit")
            if (initial.st_dev, initial.st_ino) != (info.st_dev, info.st_ino):
                raise WireError("artifact_changed")
            hasher = hashlib.sha256()
            count = 0
            with os.fdopen(os.dup(fd), "rb") as stream:
                for chunk in iter(lambda: stream.read(MAX_CHUNK), b""):
                    count += len(chunk)
                    if count > info.st_size:
                        raise WireError("artifact_limit")
                    hasher.update(chunk)
            after = os.fstat(fd)
            if count != info.st_size or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
                raise WireError("artifact_changed")
            digest = hasher.hexdigest()
            declared = getattr(attachment, "sha256", None)
            if declared is not None and declared != digest:
                raise WireError("artifact_changed")
            ref = self._add(request_id, {"fd": fd, "size": info.st_size, "digest": digest,
                "info": info, "path": attachment.local_path, "owned": attachment.owned,
                "input": True, "attachment": attachment})
            fd = None
            return {"kind": attachment.kind, "filename": attachment.filename,
                    "mime_type": attachment.mime_type, "size_bytes": info.st_size,
                    "artifact_ref": attachment.artifact_ref,
                    "provider_attachment_id": getattr(attachment, "provider_attachment_id", None),
                    "sha256": digest, "reader_ref": ref}
        finally:
            if fd is not None:
                os.close(fd)

    def read(self, request_id, params):
        object_fields(params, {"reader_ref", "offset", "length"}, {"reader_ref", "offset", "length"})
        record = self._scope(request_id).get(identifier(params["reader_ref"]))
        if record is None or not record["input"]:
            raise WireError("unknown_reader")
        offset = _integer(params["offset"], record["size"])
        length = _integer(params["length"], MAX_CHUNK)
        now = os.fstat(record["fd"])
        before = record["info"]
        if (now.st_size, now.st_mtime_ns, now.st_ctime_ns) != (before.st_size, before.st_mtime_ns, before.st_ctime_ns):
            raise WireError("artifact_changed")
        os.lseek(record["fd"], offset, os.SEEK_SET)
        data = os.read(record["fd"], min(length, record["size"] - offset))
        return {"reader_ref": params["reader_ref"], "offset": offset,
                "data_base64": base64.b64encode(data).decode("ascii"), "eof": offset + len(data) == record["size"]}

    def upload_begin(self, request_id, params):
        object_fields(params, {"kind", "filename", "mime_type", "size_bytes", "sha256"},
                      {"kind", "filename", "size_bytes", "sha256"})
        size = _integer(params["size_bytes"], MAX_ARTIFACT)
        digest = _digest(params["sha256"])
        attachment = BridgeAttachment(params["kind"], params["filename"], params.get("mime_type", "application/octet-stream"), size)
        fd, path = tempfile.mkstemp(dir=self._directory.name)
        try:
            ref = self._add(request_id, {"fd": fd, "path": path, "size": size,
                "digest": digest, "written": 0, "hasher": hashlib.sha256(),
                "complete": False, "input": False, "attachment": attachment})
        except BaseException:
            os.close(fd); os.unlink(path)
            raise
        return {"reader_ref": ref}

    def upload_chunk(self, request_id, params):
        object_fields(params, {"reader_ref", "offset", "data_base64"}, {"reader_ref", "offset", "data_base64"})
        record = self._upload(request_id, params["reader_ref"])
        if record["complete"] or _integer(params["offset"], record["size"]) != record["written"]:
            raise WireError("invalid_offset")
        encoded = params["data_base64"]
        if not isinstance(encoded, str) or len(encoded) > ((MAX_CHUNK + 2) // 3) * 4:
            raise WireError("chunk_limit")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, UnicodeError) as exc:
            raise WireError("invalid_chunk") from exc
        if not data or len(data) > MAX_CHUNK or record["written"] + len(data) > record["size"]:
            raise WireError("chunk_limit")
        remaining = memoryview(data)
        while remaining:
            count = os.write(record["fd"], remaining)
            if count <= 0:
                raise WireError("artifact_write_failed")
            remaining = remaining[count:]
        record["hasher"].update(data); record["written"] += len(data)
        return {"reader_ref": params["reader_ref"], "written": record["written"]}

    def _upload(self, request_id, ref):
        record = self._scope(request_id).get(identifier(ref))
        if record is None or record["input"]:
            raise WireError("unknown_upload")
        return record

    def upload_finish(self, request_id, params):
        object_fields(params, {"reader_ref"}, {"reader_ref"})
        record = self._upload(request_id, params["reader_ref"])
        if record["written"] != record["size"] or record["hasher"].hexdigest() != record["digest"]:
            raise WireError("artifact_hash_mismatch")
        os.fsync(record["fd"])
        record["complete"] = True
        return {"reader_ref": params["reader_ref"], "sha256": record["digest"], "size_bytes": record["size"]}

    def resolve(self, request_id, value):
        object_fields(value, {"reader_ref"}, {"reader_ref"})
        record = self._upload(request_id, value["reader_ref"])
        if not record["complete"]:
            raise WireError("incomplete_artifact")
        record["used"] = True
        original = record["attachment"]
        return BridgeAttachment(kind=original.kind, filename=original.filename, mime_type=original.mime_type,
            size_bytes=record["size"], local_path=record["path"], owned=True,
            sha256=record["digest"], reader_ref=value["reader_ref"])

    def end(self, request_id):
        for record in self._scopes.pop(request_id, {}).values():
            os.close(record["fd"])
            if record["input"]:
                self._total -= record["size"]
            elif record["complete"] and record.get("used"):
                self._retained[record["path"]] = record["size"]
            else:
                self._total -= record["size"]
                os.unlink(record["path"])
            if record["input"] and record["owned"]:
                try:
                    info = os.lstat(record["path"])
                    before = record["info"]
                    if stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) == (before.st_dev, before.st_ino):
                        os.unlink(record["path"])
                except OSError:
                    pass

    def close(self):
        for request_id in tuple(self._scopes):
            self.end(request_id)
        self._directory.cleanup()


def to_wire(value, store: ArtifactStore, request_id):
    if isinstance(value, BridgeAttachment):
        return store.register(request_id, value)
    if is_dataclass(value):
        return {field.name: to_wire(getattr(value, field.name), store, request_id) for field in fields(value)}
    if isinstance(value, (tuple, list)):
        return [to_wire(item, store, request_id) for item in value]
    if value is None or type(value) in (str, int, bool, float):
        return value
    raise WireError("unsupported_dto")


def _parts(value, store, request_id):
    if not isinstance(value, list) or len(value) > 256:
        raise WireError("invalid_parts")
    result = []
    for part in value:
        object_fields(part, {"text", "attachment"})
        text, attachment = part.get("text"), part.get("attachment")
        if text is not None and not isinstance(text, str):
            raise WireError("invalid_text")
        result.append(BridgePart(text=text, attachment=store.resolve(request_id, attachment) if attachment is not None else None))
    return tuple(result)


def capabilities(value):
    allowed = {field.name for field in fields(BridgeCapabilities)}
    object_fields(value, allowed)
    raw_commands = value.get("commands", [])
    if not isinstance(raw_commands, list) or len(raw_commands) > 256:
        raise WireError("invalid_capabilities")
    commands = []
    for command in raw_commands:
        object_fields(command, {"name", "description", "confirmation_required"}, {"name", "description"})
        identifier(command["name"])
        if not isinstance(command["description"], str) or type(command.get("confirmation_required", False)) is not bool:
            raise WireError("invalid_command")
        commands.append(BridgeCommandDefinition(**command))
    kwargs = dict(value); kwargs["commands"] = tuple(commands)
    for name in ("input_media", "output_media", "progress_kinds"):
        if name in kwargs and (not isinstance(kwargs[name], list) or len(kwargs[name]) > 64 or any(not isinstance(s, str) for s in kwargs[name])):
            raise WireError("invalid_capabilities")
    return BridgeCapabilities(**kwargs)


def result_dto(method, value, store, request_id):
    if method == "start":
        return capabilities(value)
    if method in ("authorize_context", "authorize_delivery"):
        if type(value) is not bool:
            raise WireError("invalid_authorization")
        return value
    if method == "stop":
        if value is not None:
            raise WireError("invalid_stop")
        return None
    if method == "transcribe":
        if value is not None and not isinstance(value, str):
            raise WireError("invalid_transcript")
        return value
    if method == "synthesize":
        return None if value is None else store.resolve(request_id, value)
    cls = BridgeReply if method == "send" else BridgeCommandResult
    object_fields(value, {field.name for field in fields(cls)})
    kwargs = dict(value); kwargs["parts"] = _parts(kwargs.get("parts", []), store, request_id)
    if method == "command":
        options = kwargs.pop("options", [])
        if not isinstance(options, list) or len(options) > 256:
            raise WireError("invalid_options")
        kwargs["options"] = tuple(BridgePickerOption(**object_fields(option,
            {"value", "label", "subtitle", "active"}, {"value", "label"})) for option in options)
    return cls(**kwargs)


def progress(value):
    object_fields(value, {field.name for field in fields(BridgeEvent)}, {"kind"})
    if not isinstance(value["kind"], str) or not isinstance(value.get("text", ""), str):
        raise WireError("invalid_progress")
    return BridgeEvent(**value)
