"""Coalesced, turn-owned message edits shared by messaging providers."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import timedelta

from openagent_core.media import parse_response_markers, split_preserving_code_blocks

logger = logging.getLogger(__name__)


class _MessageGate:
    def __init__(self, interval):
        self.interval, self.next_at = interval, 0.0
        self.lock = asyncio.Lock()

    async def wait(self):
        async with self.lock:
            delay = self.next_at - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            self.next_at = time.monotonic() + self.interval


class EditableMessage:
    """One provider message, with a latest-value mailbox rather than an edit queue."""
    def __init__(self, bridge, target, gate=None):
        self.bridge, self.target = bridge, target
        self.gate = gate or _MessageGate(bridge.turn_edit_interval)
        self.handle = None
        self.last = None
        self.pending = None
        self.task = None
        self.error = None
        self.sent_at = 0.0
        self.closed = False
        self.send_attempted = False

    async def update(self, text):
        if self.closed or not text:
            return
        self.pending = text
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._pump())

    async def _pump(self):
        try:
            while self.pending is not None and not self.closed:
                text, self.pending = self.pending, None
                if self.handle is not None:
                    delay = self.bridge.turn_edit_interval - (time.monotonic() - self.sent_at)
                    if delay > 0:
                        await asyncio.sleep(delay)
                    if self.pending is not None:
                        text, self.pending = self.pending, None
                await self.gate.wait()
                if self.pending is not None:
                    text, self.pending = self.pending, None
                if text == self.last:
                    continue
                if self.handle is None:
                    if self.send_attempted:
                        # A timeout can mean the provider accepted the send.
                        # Never create a duplicate because its receipt was lost.
                        raise RuntimeError("The initial channel send needs reconciliation")
                    self.send_attempted = True
                    self.handle = await self._provider_call(self.bridge.post_turn_message, self.target, text)
                    if self.handle is None:
                        raise RuntimeError("The channel did not return a message receipt")
                else:
                    await self._provider_call(self.bridge.update_turn_message, self.target, self.handle, text)
                self.last, self.sent_at = text, time.monotonic()
                self.error = None
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.error = exc
            logger.warning("Channel message update failed (%s)", type(exc).__name__)

    @staticmethod
    async def _provider_call(operation, *args):
        # Only an explicit provider rate-limit rejection is safe to retry.
        # Network timeouts can hide an accepted send and are never retried.
        for attempt in range(3):
            try:
                return await operation(*args)
            except Exception as exc:
                delay = getattr(exc, "retry_after", None)
                if isinstance(delay, timedelta):
                    delay = delay.total_seconds()
                if (attempt == 2 or type(delay) not in (int, float)
                        or not math.isfinite(delay) or not 0 <= delay <= 30):
                    raise
                await asyncio.sleep(delay)

    async def finish(self, text):
        await self.update(text)
        while self.task is not None and not self.task.done():
            await self.task
        self.closed = True
        if self.error is not None:
            raise self.error

    async def cancel(self):
        self.closed = True
        self.pending = None
        if self.task is not None and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)


class EditableTurn:
    def __init__(self, bridge, target):
        self.bridge, self.target = bridge, target
        self.gate = _MessageGate(bridge.turn_edit_interval)
        self.main = EditableMessage(bridge, target, self.gate)
        self.children = {}
        self.child_labels = {}
        self.child_states = {}
        self.text = ""
        self.operation = ""

    def visible(self):
        clean, _ = parse_response_markers(self.text)
        body = "\n\n".join(value for value in (clean.strip(), self.operation) if value)
        # The live view is a window; finish publishes the complete final answer.
        return body[-self.bridge.message_limit:]

    async def delta(self, text):
        self.text = text
        self.operation = ""
        await self.main.update(self.visible())

    async def status(self, raw):
        from .base import format_tool_status
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict) and isinstance(data.get("child_session_id"), str):
            child = data["child_session_id"]
            args = data.get("tool_args") or {}
            label = args.get("member_id", "") if isinstance(args, dict) else ""
            await self.child(child, "Thinking…", label=label)
            self.operation = "Waiting for sub-agent…"
        else:
            self.operation = format_tool_status(raw)
        await self.main.update(self.visible())

    async def child(self, session_id, operation, *, label="", terminal=False):
        if not isinstance(session_id, str) or not session_id:
            return
        if self.child_states.get(session_id):
            return
        if label:
            self.child_labels[session_id] = str(label)[:100]
        if terminal:
            self.child_states[session_id] = operation
        message = self.children.setdefault(session_id, EditableMessage(self.bridge, self.target, self.gate))
        title = "Delegated to sub-agent"
        if self.child_labels.get(session_id):
            title += " · " + self.child_labels[session_id]
        await message.update((title + "\n\n" + operation)[:self.bridge.message_limit])

    async def child_frame(self, frame):
        from .base import format_tool_status
        sid, kind = frame.get("session_id"), frame.get("type") or frame.get("kind")
        if kind == "status":
            await self.child(sid, format_tool_status(frame.get("text") or "Thinking…"))
        elif kind in {"turn_complete", "done"}:
            reason = frame.get("reason") or frame.get("end_reason") or "completed"
            label = "Completed" if reason in {"completed", "success"} else "Stopped" if reason in {"cancelled", "interrupted", "stopped"} else "Failed"
            await self.child(sid, label, terminal=True)
        elif kind == "error":
            await self.child(sid, "Failed", terminal=True)
        elif sid and sid not in self.children:
            await self.child(sid, "Thinking…")

    async def finish(self, text, *, child_outcome="Completed"):
        # Provider size limits still apply. Only a final overlong answer needs
        # continuation messages; tools and narration never create more bubbles.
        from .base import _extract_choice_marker
        text, choices = _extract_choice_marker(text)
        chunks = split_preserving_code_blocks(text, self.bridge.message_limit) if text else []
        if chunks:
            await self.main.finish(chunks[0])
            for chunk in chunks[1:]:
                await self.bridge.send_text_chunk(self.target, chunk)
        else:
            await self.main.finish(self.visible() or "Completed")
        if choices and self.main.handle is not None:
            await self.bridge.set_turn_choices(self.target, self.main.handle, choices)
        for sid, message in self.children.items():
            title = "Delegated to sub-agent"
            if self.child_labels.get(sid):
                title += " · " + self.child_labels[sid]
            await message.finish(title + "\n\n" + self.child_states.get(sid, child_outcome))

    async def cancel(self):
        await asyncio.gather(self.main.cancel(), *(message.cancel() for message in self.children.values()))
