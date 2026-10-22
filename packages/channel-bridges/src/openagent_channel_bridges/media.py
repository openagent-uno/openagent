"""Provider download names, byte limits and media classification.

These helpers neither open an agent directory nor import an engine, database,
model or voice backend. The host owns staging and actual transcription.
"""
from __future__ import annotations

from collections.abc import Mapping
import os
from pathlib import Path
import re
from typing import Any


AUDIO_EXTENSIONS = frozenset({".webm", ".ogg", ".mp3", ".wav", ".m4a", ".opus", ".flac"})
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]+")


def is_audio_file(filename: str | None, content_type: str | None = None) -> bool:
    """Classify an upload without loading a transcription implementation."""
    if content_type and content_type.startswith("audio/"):
        return True
    return bool(filename and Path(filename).suffix.lower() in AUDIO_EXTENSIONS)


def attachment_limit_bytes(*, direction: str = "input",
                           environment: Mapping[str, str] | None = None) -> int:
    """Return the configured input/output cap; an explicit zero disables it.

    Hosts may supply an instance-owned mapping. Without one, standalone's
    existing OPENAGENT_MAX_*_ATTACHMENT_MB process settings remain compatible.
    No current-runtime lookup or default agent construction is performed.
    """
    values = os.environ if environment is None else environment
    key = "OPENAGENT_MAX_INBOUND_ATTACHMENT_MB" if direction == "input" else "OPENAGENT_MAX_ATTACHMENT_MB"
    default = 64 if direction == "input" else 256
    try:
        mb = int(values.get(key, str(default)) or str(default))
    except (TypeError, ValueError):
        mb = default
    return max(0, mb) * 1024 * 1024


def _basename(value: Any) -> str:
    raw = str(value or "").replace("\\", "/")
    return _CONTROL_CHARACTERS.sub("", raw.rsplit("/", 1)[-1]).strip().strip(".")


def safe_attachment_filename(value: Any, *, fallback: str = "attachment") -> str:
    """Return one staging basename, at most 240 UTF-8 bytes, retaining suffix."""
    name = _basename(value) or _basename(fallback) or "attachment"
    suffix = Path(name).suffix[:24]
    encoded = name.encode("utf-8")
    if len(encoded) > 240:
        suffix_bytes = suffix.encode("utf-8")
        stem = name[:-len(suffix)] if suffix else name
        # Decoding with ignore removes only an incomplete final code point.
        stem = stem.encode("utf-8")[:max(1, 240 - len(suffix_bytes))].decode("utf-8", errors="ignore")
        name = (stem or "a") + suffix
    return name


def safe_attachment_staging_name(prefix: Any, filename: Any) -> str:
    """Bound the combined private staging component, not just its two halves."""
    safe_prefix = safe_attachment_filename(prefix, fallback="attachment-id")
    safe_name = safe_attachment_filename(filename)
    return safe_attachment_filename(f"{safe_prefix}-{safe_name}")


MEDIA_CHUNK_BYTES = 64 * 1024


class MediaTransferTooLarge(ValueError):
    def __init__(self, size_bytes):
        super().__init__("Inbound media exceeds the byte limit")
        self.size_bytes = size_bytes


def media_file_snapshot(path, *, limit: int = 0) -> tuple[int, int, int, int]:
    """Bind an ordinary host-supplied file without following a symlink."""
    import stat
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or limit and info.st_size > limit:
        raise ValueError("Media file is unavailable or exceeds the byte limit")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


async def authorized_file_chunks(path, authorize, *, snapshot, limit: int = 0):
    """Read/yield bounded bytes only after current host authorization.

    The provider receives an async iterable instead of a pathname that its SDK
    could eagerly read without an authorization boundary for each chunk.
    """
    await authorize()
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as source:
        def unchanged():
            info = os.fstat(source.fileno())
            actual = info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns
            if actual != snapshot or limit and info.st_size > limit:
                raise ValueError("Media file changed during transfer")
        unchanged()
        copied = 0
        while True:
            await authorize()
            unchanged()
            chunk = source.read(MEDIA_CHUNK_BYTES)
            if not chunk:
                break
            copied += len(chunk)
            if copied > snapshot[2] or limit and copied > limit:
                raise ValueError("Media file exceeds the byte limit")
            await authorize()
            unchanged()
            yield chunk
        await authorize()
        unchanged()
        if copied != snapshot[2]:
            raise ValueError("Media file transfer was incomplete")


async def write_authorized_download(content, path, authorize, *, limit: int = 0) -> int:
    """Stage only new private files; reject/revoke before every chunk write."""
    target = Path(path)
    owned_identity = None
    try:
        await authorize()
        with target.open("xb") as output:
            info = os.fstat(output.fileno())
            owned_identity = info.st_dev, info.st_ino
            copied = 0
            iterator = content.iter_chunked(MEDIA_CHUNK_BYTES).__aiter__()
            while True:
                await authorize()
                try:
                    chunk = await anext(iterator)
                except StopAsyncIteration:
                    break
                await authorize()
                copied += len(chunk)
                if limit and copied > limit:
                    raise MediaTransferTooLarge(copied)
                output.write(chunk)
            await authorize()
        return copied
    except BaseException:
        if owned_identity is not None:
            try:
                info = target.lstat()
                if (info.st_dev, info.st_ino) == owned_identity and not target.is_symlink():
                    target.unlink()
            except OSError:
                pass
        raise


async def read_authorized_response(content, authorize, *, limit: int = 65536) -> bytes:
    """Read a bounded provider response only while the host grant remains valid."""
    chunks, copied = [], 0
    while True:
        await authorize()
        chunk = await content.read(min(MEDIA_CHUNK_BYTES, limit + 1 - copied))
        await authorize()
        if not chunk:
            return b"".join(chunks)
        copied += len(chunk)
        if copied > limit:
            raise ValueError("Media response exceeds the byte limit")
        chunks.append(chunk)
