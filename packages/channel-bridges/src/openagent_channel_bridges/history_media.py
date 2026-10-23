"""Request-local historical media, using the provider's ordinary safe reader."""
from __future__ import annotations

from dataclasses import replace
from .contracts import BridgeAttachment, BridgeAttachmentNotice, BridgePart
from .media import media_file_snapshot
from .diagnostics import emit_diagnostic
from openagent_core.media import is_blocked_attachment

class HistoryUnavailable(RuntimeError):
    """Requested provider history was not obtained; never invent empty input."""


MAX_HISTORY_FILES = 16
MAX_HISTORY_INPUT_BYTES = 64 << 20
MAX_HISTORY_FILE_BYTES = 32 << 20


async def prepare_history_media(bridge, history, context, load, *, current_attachments=()):
    """Materialize only a selected, bounded history window. Never grant access.

    ``load`` is a provider-owned callback that uses its existing authenticated,
    bounded download implementation. The caller retains the request directory
    until dispatch finishes, including IPC reads and host artifact ingestion.
    """
    await bridge._ensure_transport_started()
    file_limit = bridge._capabilities.history_max_files
    count = len(current_attachments)
    size = sum(int(value.get("size_bytes") or 0) for value in current_attachments)
    selected, part_count = [], count + 1  # current human text is a part too
    for record in reversed(history):
        added = len(record.parts) + len(record.omitted_attachments)
        if part_count + added <= 256:
            selected.insert(0, record)
            part_count += added
    result = []
    transcriptions = 0
    for record in selected:
        parts, omitted = [], list(record.omitted_attachments)
        for part in record.parts:
            attachment = part.attachment
            if attachment is None:
                parts.append(part)
                continue
            reason = None
            if is_blocked_attachment(attachment.filename):
                reason = "blocked"
            elif not bridge._capabilities.history_media or attachment.kind not in bridge._capabilities.input_media:
                reason = "unsupported"
            elif (count >= file_limit or attachment.size_bytes > MAX_HISTORY_FILE_BYTES
                  or size + attachment.size_bytes > MAX_HISTORY_INPUT_BYTES):
                reason = "limit"
            else:
                context = await bridge._prepare_delivery_context(context)
                try:
                    loaded = await load(record, attachment,
                                        min(MAX_HISTORY_FILE_BYTES, MAX_HISTORY_INPUT_BYTES - size))
                    context = await bridge._prepare_delivery_context(context)
                    if not isinstance(loaded, BridgeAttachment) or not loaded.local_path:
                        raise ValueError("Historical media reader unavailable")
                    snapshot = media_file_snapshot(loaded.local_path, limit=MAX_HISTORY_FILE_BYTES)
                    if (loaded.provider_attachment_id != attachment.provider_attachment_id
                            or loaded.filename != attachment.filename or loaded.kind != attachment.kind
                            or loaded.size_bytes != snapshot[2]
                            or size + snapshot[2] > MAX_HISTORY_INPUT_BYTES):
                        raise ValueError("Historical media identity or budget changed")
                    count += 1
                    size += snapshot[2]
                    emit_diagnostic(context, "history", "completed", files=count, bytes=size, transcriptions=transcriptions)
                    parts.append(BridgePart(attachment=loaded))
                except PermissionError:
                    raise
                except (OSError, ValueError, RuntimeError):
                    reason = "unavailable"
                if reason is None and loaded.kind in ("voice", "audio"):
                    transcript = await bridge.transcribe_with_fallback(
                        loaded.local_path, context=context, attachment=loaded)
                    context = await bridge._prepare_delivery_context(context)
                    transcriptions += 1
                    if part_count < 256:
                        parts.append(BridgePart(text="Audio transcript (quoted historical message):\n" + transcript))
                        part_count += 1
            if reason is not None:
                omitted.append(BridgeAttachmentNotice(attachment.kind, attachment.filename,
                    attachment.mime_type, attachment.size_bytes, attachment.provider_attachment_id, reason))
        result.append(replace(record, parts=tuple(parts), omitted_attachments=tuple(omitted)))
    emit_diagnostic(context, "history", "completed", files=count, bytes=size, transcriptions=transcriptions)
    return tuple(result)
