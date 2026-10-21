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
