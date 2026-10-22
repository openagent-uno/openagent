"""Closed, content-free CLI diagnostics; never relay arbitrary stderr."""
from __future__ import annotations
import hashlib
import json
import sys

PREFIX = "OA_CHANNEL_DIAGNOSTIC_V1 "
PROVIDERS = frozenset({"slack", "discord", "telegram", "whatsapp"})
STAGES = frozenset({"admission", "history", "transcription", "submission", "delivery", "terminal"})
CODES = frozenset({"started", "completed", "failed", "authorization_denied", "unavailable", "cancelled"})


def emit_diagnostic(context, stage, code, *, files=0, bytes=0, transcriptions=0):
    """Emit bounded enums/counts and an irreversible exact-event correlation.

    This record is observation only. It never conveys a grant, transcript,
    provider/host ID, URL, path, filename, exception string or credential.
    """
    if context.provider not in PROVIDERS or stage not in STAGES or code not in CODES:
        raise ValueError("invalid diagnostic enum")
    counters = {"files": files, "bytes": bytes, "transcriptions": transcriptions}
    for name, maximum in (("files", 64), ("bytes", 64 << 20), ("transcriptions", 64)):
        if type(counters[name]) is not int or not 0 <= counters[name] <= maximum:
            raise ValueError("invalid diagnostic counter")
    framed = b"oa-channel-diagnostic/v1\n" + json.dumps(list(context.deduplication_key),
        ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    value = {"schema_version": 1, "provider": context.provider, "stage": stage, "code": code,
             "event_sha256": hashlib.sha256(framed).hexdigest(), "counters": counters}
    line = PREFIX + json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n"
    if len(line.encode("utf-8")) > 1024:
        raise ValueError("diagnostic exceeds bound")
    try:
        if sys.stderr is not None:
            sys.stderr.write(line)
            sys.stderr.flush()
    except (OSError, ValueError):
        pass  # A closed observer must not change the authorized operation.
