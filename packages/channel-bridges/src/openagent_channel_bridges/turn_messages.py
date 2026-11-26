"""Coalesced, turn-owned message edits shared by messaging providers."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import timedelta

from openagent_core.media import parse_response_markers
from openagent_core.stream.content_parts import ContentMarkerStreamFilter

logger = logging.getLogger(__name__)


class EditableDeliveryDeferred(RuntimeError):
    """The destination cannot accept an editable message within its delivery budget."""


def _explicit_retry_delay(error):
    delay = getattr(error, "retry_after", None)
    if isinstance(delay, timedelta):
        delay = delay.total_seconds()
    if type(delay) in (int, float) and math.isfinite(delay) and delay >= 0:
        return delay
    return None


class DeliveryCooldown:
    """One provider destination's explicit not-before time."""

    def __init__(self):
        self.ready_at = 0.0
        self.next_message_at = 0.0
        self.lock = asyncio.Lock()

    def active(self):
        return time.monotonic() < self.ready_at

    def observe(self, error):
        delay = _explicit_retry_delay(error)
        if delay is not None:
            self.ready_at = max(self.ready_at, time.monotonic() + delay)
        return delay


class _MessageGate:
    def __init__(self, interval, cooldown=None):
        self.interval = interval
        self.cooldown = cooldown if cooldown is not None else DeliveryCooldown()

    async def wait(self, deadline):
        async with self.cooldown.lock:
            while True:
                now = time.monotonic()
                ready = max(self.cooldown.next_message_at, self.cooldown.ready_at)
                if ready > deadline or now >= deadline:
                    raise EditableDeliveryDeferred("Channel provider cooldown exceeds the delivery deadline")
                if ready <= now:
                    self.cooldown.next_message_at = now + self.interval
                    return
                await asyncio.sleep(ready - now)


class EditableMessage:
    """One provider message, with a latest-value mailbox rather than an edit queue."""
    def __init__(self, bridge, target, gate=None):
        self.bridge, self.target = bridge, target
        self.gate = gate or _MessageGate(bridge.turn_edit_interval)
        # Legacy providers keep the previous two 30-second retries plus
        # pacing. Telegram has a longer, explicit total delivery budget.
        self.retry_budget = getattr(bridge, "turn_retry_budget", None)
        self.single_retry_limit = self.retry_budget or 30.0
        self.handle = None
        self.last = None
        self.pending = None
        self.task = None
        self.error = None
        self.sent_at = 0.0
        self.closed = False
        self.send_attempted = False

    def _deadline(self):
        return time.monotonic() + (self.retry_budget or 65.0)

    async def update(self, text):
        if self.closed or not text:
            return
        idle = self.task is None or self.task.done()
        if idle and self.pending is None and text == self.last and self.error is None:
            return
        self.pending = text
        if idle:
            if self.gate.cooldown.ready_at > self._deadline():
                if self.error is None:
                    self.error = EditableDeliveryDeferred("Channel provider cooldown exceeds the delivery deadline")
                    logger.warning("Channel message update deferred by provider cooldown")
                return
            self.task = asyncio.create_task(self._pump())

    async def _pump(self):
        try:
            while self.pending is not None and not self.closed:
                deadline = self._deadline()
                if self.handle is not None:
                    delay = self.bridge.turn_edit_interval - (time.monotonic() - self.sent_at)
                    if delay > 0:
                        await asyncio.sleep(delay)
                await self.gate.wait(deadline)
                text, self.pending = self.pending, None
                if text == self.last and self.error is None:
                    continue
                if self.handle is None:
                    if self.send_attempted:
                        # A timeout can mean the provider accepted the send.
                        # Never create a duplicate because its receipt was lost.
                        raise RuntimeError("The initial channel send needs reconciliation")
                    self.handle, text = await self._provider_call(
                        self.bridge.post_turn_message, (self.target,), text, deadline, initial=True)
                    if self.handle is None:
                        raise RuntimeError("The channel did not return a message receipt")
                else:
                    _, text = await self._provider_call(
                        self.bridge.update_turn_message, (self.target, self.handle), text, deadline)
                self.last, self.sent_at = text, time.monotonic()
                self.error = None
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.error = exc
            logger.warning("Channel message update failed (%s)", type(exc).__name__)

    async def _provider_call(self, operation, args, text, deadline, *, initial=False, coalesce=True):
        # Only an explicit provider rate-limit rejection is safe to retry.
        # Network timeouts can hide an accepted send and are never retried.
        for attempt in range(3):
            if coalesce and self.pending is not None:
                text, self.pending = self.pending, None
            if coalesce and not initial and text == self.last and self.error is None:
                return None, text
            if initial:
                self.send_attempted = True
            try:
                return await operation(*args, text), text
            except Exception as exc:
                delay = self.gate.cooldown.observe(exc)
                if delay is None:
                    raise
                if initial:
                    self.send_attempted = False  # Telegram explicitly rejected this send.
                if delay > self.single_retry_limit:
                    raise EditableDeliveryDeferred("Channel provider cooldown exceeds the retry budget") from None
                if attempt == 2:
                    raise
                await self.gate.wait(deadline)

    async def send_followup(self, operation, args, payload):
        deadline = self._deadline()
        await self.gate.wait(deadline)
        await self._provider_call(operation, args, payload, deadline, coalesce=False)

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
        cooldown_for_destination = getattr(bridge, "editable_turn_cooldown", None)
        cooldown = cooldown_for_destination() if callable(cooldown_for_destination) else None
        self.gate = _MessageGate(bridge.turn_edit_interval, cooldown)
        self.main = EditableMessage(bridge, target, self.gate)
        self.children = {}
        self.child_labels = {}
        self.child_states = {}
        self.child_text = {}
        self.child_filters = {}
        self.text = ""
        self.operation = ""
        self.finalizing = False

    def visible(self):
        clean, _ = parse_response_markers(self.text)
        body = "\n\n".join(value for value in (clean.strip(), self.operation) if value)
        # The live view is a window; finish publishes the complete final answer.
        return body[-self.bridge.message_limit:]

    async def delta(self, text):
        if self.finalizing:
            return
        self.text = text
        self.operation = ""
        await self.main.update(self.visible())

    async def status(self, raw):
        if self.finalizing:
            return
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
        if self.finalizing or not isinstance(session_id, str) or not session_id:
            return
        if self.child_states.get(session_id):
            return
        if label:
            self.child_labels[session_id] = str(label)[:100]
        if terminal:
            self.child_states[session_id] = operation
        message = self.children.get(session_id)
        if message is None:
            message = self.children[session_id] = EditableMessage(self.bridge, self.target, self.gate)
        await message.update(self._child_body(session_id, operation))

    def _child_body(self, session_id, operation):
        title = "Delegated to sub-agent"
        if self.child_labels.get(session_id):
            title += " · " + self.child_labels[session_id]
        # Keep the heading and current operation visible when a long child
        # answer must fit the same editable receipt.
        operation = operation[:max(0, self.bridge.message_limit - len(title) - 2)]
        budget = self.bridge.message_limit - len(title) - len(operation) - 4
        narration = self.child_text.get(session_id, "").strip()
        if budget > 0:
            narration = narration[-budget:]
        else:
            narration = ""
        return "\n\n".join(part for part in (title, narration, operation) if part)

    async def child_frame(self, frame):
        if self.finalizing:
            return
        from .base import format_tool_status
        sid, kind = frame.get("session_id"), frame.get("type") or frame.get("kind")
        if not isinstance(sid, str) or not sid or sid in self.child_states:
            return
        if kind in {"delta", "response"}:
            text = frame.get("text")
            if not isinstance(text, str):
                return
            if kind == "response":
                # The canonical child reply supersedes streamed prose.
                snapshot_filter = ContentMarkerStreamFilter()
                self.child_text[sid] = (snapshot_filter.feed(text) + snapshot_filter.finish())[-self.bridge.message_limit:]
                self.child_filters.pop(sid, None)
            else:
                marker_filter = self.child_filters.get(sid)
                if marker_filter is None:
                    marker_filter = self.child_filters[sid] = ContentMarkerStreamFilter()
                visible = marker_filter.feed(text)
                marker_filter.refs.clear()  # Child progress carries no downloadable media or inline UI.
                self.child_text[sid] = (self.child_text.get(sid, "") + visible)[-self.bridge.message_limit:]
            await self.child(sid, "")
        elif kind == "status":
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
        # Give already-pending writers the terminal text before waiting for
        # Telegram. Nothing can flush an outdated draft after cooldown.
        self.finalizing = True
        child_updates = [(message, self._child_body(sid, self.child_states.get(sid, child_outcome)))
                         for sid, message in self.children.items()]
        try:
            async with asyncio.timeout(self.main.retry_budget):
                for message, final in child_updates:
                    await message.update(final)
                from .base import _extract_choice_marker
                text, choices = _extract_choice_marker(text)
                chunks = self.bridge.split_text(text) if text else []
                await self.main.finish(chunks[0] if chunks else self.visible() or "Completed")
                for chunk in chunks[1:]:
                    await self.main.send_followup(self.bridge.send_text_chunk, (self.target,), chunk)
                if choices and self.main.handle is not None:
                    await self.main.send_followup(self.bridge.set_turn_choices, (self.target, self.main.handle), choices)
                for message, final in child_updates:
                    await message.finish(final)
        finally:
            await self.cancel()

    async def cancel(self):
        self.finalizing = True
        await asyncio.gather(self.main.cancel(), *(message.cancel() for message in self.children.values()))
