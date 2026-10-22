"""Shared platform delivery orchestration with an explicit host transport."""
from __future__ import annotations

import asyncio
import contextvars
import functools
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Awaitable

from openagent_core.media import Attachment, parse_response_markers, split_preserving_code_blocks
from .contracts import (BridgeAttachment, BridgeCapabilities, BridgeCommand, BridgeContext,
    BridgeEvent, BridgeHistoryMessage, BridgeMessage, BridgePart, BridgeReply, BridgeTransport)

from .diagnostics import emit_diagnostic

logger = logging.getLogger(__name__)
BRIDGE_RETRY_SECONDS = 30
BRIDGE_GATEWAY_RECONNECT_BASE_SECONDS = float(os.environ.get("OPENAGENT_BRIDGE_GATEWAY_RECONNECT_BASE_SECONDS", "1"))
BRIDGE_GATEWAY_RECONNECT_MAX_SECONDS = float(os.environ.get("OPENAGENT_BRIDGE_GATEWAY_RECONNECT_MAX_SECONDS", "60"))
BRIDGE_GATEWAY_RECONNECT_STABLE_SECONDS = float(os.environ.get("OPENAGENT_BRIDGE_GATEWAY_RECONNECT_STABLE_SECONDS", "60"))
VOICE_FALLBACK = "[Voice message could not be transcribed. Ask the user to type it.]"
BRIDGE_COALESCE_WINDOW_MS = 1500
_active_context = contextvars.ContextVar("channel_bridge_context", default=None)
_active_history = contextvars.ContextVar("channel_bridge_history", default=())
_legacy_session_hint = contextvars.ContextVar("channel_bridge_session_hint", default=None)
_legacy_target_hint = contextvars.ContextVar("channel_bridge_target_hint", default=None)
_legacy_reply_target = contextvars.ContextVar("channel_bridge_reply_target", default=None)


def elog(event: str, *, level: str = "info", **fields) -> None:
    """Log bounded diagnostics without channel content, paths or identifiers."""
    safe = {}
    for key, value in fields.items():
        if key in {"bridge", "name"} and isinstance(value, str) and value in {"bridge", "slack", "discord", "telegram", "whatsapp"}:
            safe[key] = value
        elif key == "error_type" and isinstance(value, str) and value.isidentifier() and len(value) <= 80:
            safe[key] = value
        elif key == "reason" and isinstance(value, str) and value in {"not_allowed_user", "dm_only_rejecting_guild", "guild_not_allowed", "channel_not_listened", "unexpected_host"}:
            safe[key] = value
        elif key in {"count", "size_bytes", "limit_bytes", "allowed_users", "allowed_guilds", "listen_channels",
                     "retry_after_s", "retry_in", "timeout", "dm_only", "had_polling_task", "dropped_cleanup"}:
            if isinstance(value, (int, float)) and 0 <= value <= 2**63 - 1:
                safe[key] = value
    logger.log(getattr(logging, level.upper(), logging.INFO), "%s %r", event, safe)

PERSONALITY_PRESETS: dict[str, str] = {
    "casual": (
        "Respond in a friendly, conversational tone — like texting a "
        "knowledgeable friend. Skip corporate formality. Italian or "
        "English, whichever the user speaks."
    ),
    "technical": (
        "Respond as a senior engineer: precise, terse, code-first. "
        "Include exact commands, paths, and gotchas. No marketing prose."
    ),
    "teacher": (
        "Explain like a patient teacher — clear concepts, short examples, "
        "name the trade-offs. Assume an attentive but non-expert audience."
    ),
    "kawaii": (
        "You are a kawaii assistant! Use cute expressions like (◕‿◕), ★, ♪, "
        "and ~! Add sparkles, be super enthusiastic, end sentences with desu~. "
        "Stay helpful underneath the cuteness."
    ),
    "pirate": (
        "Arrr! Ye be talkin' to a tech-savvy pirate. Speak like a proper "
        "buccaneer, use nautical terms, treat every problem like treasure "
        "waitin' to be plundered. Yo ho ho!"
    ),
    "noir": (
        "Respond in 1940s detective noir voice: short hard sentences, rain "
        "and shadow metaphors, world-weary observations. Underneath, give "
        "the same accurate answer."
    ),
    "philosopher": (
        "Frame each answer as a brief reflection: name the underlying "
        "tension, offer the resolution, end with one sentence about why "
        "it matters. Stay practical though — the user has work to do."
    ),
}


_CHOICE_MARKER_RE = __import__("re").compile(r"\[CHOICE:\s*([^\]]+)\]")


def _extract_choice_marker(text: str) -> tuple[str, list[str]]:
    """Find a single CHOICE marker, return (cleaned_text, options).
    Multiple markers collapse to the first — the bot shouldn't be
    asking two questions in one turn anyway."""
    m = _CHOICE_MARKER_RE.search(text or "")
    if m is None:
        return text or "", []
    raw = m.group(1)
    opts = [seg.strip() for seg in raw.split("|") if seg.strip()]
    cleaned = (text[: m.start()] + text[m.end():]).strip()
    return cleaned, opts[:8]  # Telegram inline-keyboard practical cap


def resolve_personality_directive(personality: str | None) -> str | None:
    """Translate a ``personality`` config value into the system-style
    directive that gets prepended to the user turn. ``None`` / empty
    returns ``None`` (no overlay). A preset name resolves through
    :data:`PERSONALITY_PRESETS`; any other string is treated as a literal
    persona directive so users can drop in their own one-liner without
    code changes (e.g. ``channels.telegram.personality: "Risponde sempre
    in italiano informale"``).
    """
    if not personality:
        return None
    cleaned = personality.strip()
    if not cleaned:
        return None
    preset = PERSONALITY_PRESETS.get(cleaned.lower())
    return preset or cleaned


def format_tool_status(raw: str) -> str:
    """Convert a raw status string (possibly JSON tool event) into a
    human-readable line suitable for Telegram/Discord/WhatsApp.

    Structured events are API-native: ``{"tool_name": "bash",
    "tool_call_error": false, "result": ...}``; phase is derived from
    the bool + ``result`` presence. Plain strings like ``"Thinking..."``
    pass through unchanged.

    Tool labels are FRIENDLY — memory-vault ops read "Recalling Brain" /
    "Memorizing Brain", a shell call reads "Running command", etc. (see
    :mod:`openagent_channel_bridges.tool_labels`, the twin of the app's tool chips).
    """
    from openagent_core.media import parse_status_event
    from openagent_channel_bridges.tool_labels import status_line
    evt = parse_status_event(raw)
    if evt is None:
        return raw
    return status_line(evt)


def format_tool_message(raw: str) -> str | None:
    """Render a tool-status event as a STANDALONE chat message for live
    mode (vs ``format_tool_status`` which feeds an editable status line).

    Returns ``None`` for events that should NOT get their own message so
    the chat isn't flooded:

    * non-tool statuses (``"Thinking..."``, ``"Loading context..."``) —
      ``parse_status_event`` yields ``None`` for these. (Session compaction
      no longer arrives here at all — it rides its own ``session_compacted``
      frame into ``dispatch_turn``'s ``on_compaction`` notice.)
    * tool *completion* pings — the runtime emits a (running, done) pair
      per tool; we surface the invocation and any failure, but a "done"
      bubble for every tool would double the message count.

    The line is FRIENDLY and on-brand — "🧠 Memorizing — Brain",
    "📖 Recalling — Brain", "🔧 Running command" — mirroring the app's
    tool chips (see :mod:`openagent_channel_bridges.tool_labels`). Mirrors the Hermes
    UX of narrating each tool call in-chat.
    """
    from openagent_core.media import parse_status_event
    from openagent_channel_bridges.tool_labels import message_line
    evt = parse_status_event(raw)
    if evt is None:
        return None
    if evt.status in ("running", "error"):
        return message_line(evt)
    return None  # "done" — skip; the invocation line already landed


class _LiveProgress:
    """Per-turn bookkeeping for live-message mode.

    In live mode ``dispatch_turn`` posts each tool invocation and each
    span of assistant narration as its own chat message *as the turn
    unfolds* — instead of one final reply — while the platform "is
    writing" indicator stays lit (vision §9: a channel translates the
    agent's outbound stream into platform-native messages).

    Created fresh per ``dispatch_turn`` and captured by that turn's
    ``on_status`` / ``on_delta`` closures, so concurrent turns on the
    same bridge instance never share state. Text is tracked by character
    offset into the collector's raw accumulated delta stream
    (``StreamCollector.accumulated_text``) — that stream only ever grows
    and is updated in frame order, so a simple high-water mark is enough
    to know what is still unposted.
    """

    __slots__ = ("posted_chars", "posted_any", "latest")

    def __init__(self) -> None:
        # High-water mark: chars of the raw accumulated stream already
        # posted as messages.
        self.posted_chars = 0
        # Whether ANY live message (tool line or narration) was posted.
        # Gates the end-of-turn path: if nothing streamed, fall back to
        # the normal single-reply render so error/empty turns behave
        # exactly as before.
        self.posted_any = False
        # Most recent accumulated text seen via ``on_delta`` — a fallback
        # source when the collector can't be read (it shouldn't normally
        # happen mid-turn, but the on_delta value is always safe).
        self.latest = ""


class BaseBridge:
    """Provider-independent delivery; the injected transport owns host execution."""
    name = "bridge"
    message_limit = 4000
    _personality_directive = None
    _live = True

    def __init__(self, *, transport: BridgeTransport, binding_id: str | None = None,
                 personality: str | None = None, live: bool | None = None,
                 delivery_mode: str | None = None, acknowledgement_text: str | None = None):
        if transport is None:
            raise ValueError("an explicit bridge transport is required")
        self.transport = transport
        self.binding_id = binding_id
        self._personality_directive = resolve_personality_directive(personality)
        if delivery_mode not in (None, "quiet", "live"):
            raise ValueError("delivery_mode must be quiet or live")
        if delivery_mode is not None and live is not None:
            raise ValueError("choose delivery_mode or the legacy live option")
        # Explicit legacy live=False keeps final-only delivery. The default
        # quiet profile acknowledges once and never publishes intermediate IO.
        self._delivery_mode = delivery_mode or ("quiet" if live is None else "live" if live else "final")
        self._live = self._delivery_mode == "live"
        if acknowledgement_text is not None and (not isinstance(acknowledgement_text, str)
                or not acknowledgement_text.strip() or len(acknowledgement_text.encode("utf-8")) > 512
                or any(ord(char) < 32 or ord(char) == 127 for char in acknowledgement_text)):
            raise ValueError("acknowledgement_text must be a nonempty single line of at most 512 UTF-8 bytes")
        self._acknowledgement_text = acknowledgement_text or "Received. I’ll reply when finished."
        self._should_stop = False
        self._generation = 0
        self._gateway_lost = getattr(transport, "loss_event", None) or asyncio.Event()
        self._transport_started = False
        self._transport_lock = asyncio.Lock()
        self._start_task = None
        self._pending_transports: set[asyncio.Task] = set()
        self._owned_artifacts: dict[str, tuple[int, int]] = {}
        self._capabilities = BridgeCapabilities()
        binder = getattr(transport, "bind_bridge", None)
        if binder is not None:
            binder(self)

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        # Platform overrides remain the existing SDK primitives. Recheck the
        # task's authenticated context immediately before every outbound IO.
        for name in ("send_text_chunk", "send_attachment", "post_status", "update_status",
                     "clear_status", "stream_text", "send_choice_buttons", "render_picker",
                     "post_compaction_notice", "resolve_compaction_notice", "ack_follower"):
            method = cls.__dict__.get(name)
            if method is None or getattr(method, "_context_guarded", False):
                continue
            def guarded(original):
                @functools.wraps(original)
                async def call(self, *args, **kwargs):
                    await self._authorize_outbound()
                    return await original(self, *args, **kwargs)
                call._context_guarded = True
                return call
            setattr(cls, name, guarded(method))

    def _resolve_context(self, context: BridgeContext | None = None) -> BridgeContext:
        value = context if context is not None else _active_context.get()
        if not isinstance(value, BridgeContext):
            raise PermissionError("an authenticated bridge context is required")
        if self.binding_id is not None and value.binding_id != self.binding_id:
            raise PermissionError("bridge binding changed")
        if self.name != "bridge" and value.provider != self.name:
            raise PermissionError("bridge provider differs from context")
        return value

    async def authorize_context(self, context: BridgeContext) -> None:
        generation = self._generation
        if self._should_stop:
            raise PermissionError("bridge is stopped")
        value = self._resolve_context(context)
        if await self.transport.authorize_context(value) is not True:
            raise PermissionError("bridge context is no longer authorized")
        if self._should_stop or generation != self._generation:
            raise PermissionError("bridge is stopped")
        _active_context.set(value)

    async def _delivery_context(self, context: BridgeContext) -> BridgeContext:
        """Providers may refresh SDK-attested audience fields before egress."""
        return context

    @staticmethod
    def _same_delivery_identity(left: BridgeContext, right: BridgeContext) -> bool:
        return all(getattr(left, field) == getattr(right, field) for field in (
            "binding_id", "provider", "account_id", "actor_id", "conversation_id",
            "event_id", "thread_id", "reply_to_event_id", "api_version", "conversation_kind"))

    async def _prepare_delivery_context(self, current: BridgeContext) -> BridgeContext:
        """Refresh audience once and obtain the host's current delivery grant."""
        current = self._resolve_context(current)
        generation = self._generation
        # Membership reads must themselves follow actor/binding admission.
        await self._authorize_generation(current, generation)
        self._resolve_context(current)
        delivery = await self._delivery_context(current)
        if self._should_stop or generation != self._generation:
            raise PermissionError("bridge generation changed")
        if not isinstance(delivery, BridgeContext) or not self._same_delivery_identity(current, delivery):
            raise PermissionError("delivery audience refresh changed bridge identity")
        if current.conversation is not None and current.conversation != delivery.conversation:
            # A freshly admitted recipient is not retroactively an audience of
            # an answer already running under the previous membership epoch.
            raise PermissionError("delivery conversation audience epoch changed")
        self._resolve_context(delivery)
        await self._authorize_generation(delivery, generation)
        self._resolve_context(delivery)
        authorize_delivery = getattr(self.transport, "authorize_delivery", None)
        if getattr(delivery, "conversation_kind", "unknown") != "direct":
            if getattr(delivery, "audience_complete", False) is not True or not callable(authorize_delivery):
                raise PermissionError("group delivery requires a complete audience and host policy")
        if callable(authorize_delivery):
            if await authorize_delivery(delivery) is not True:
                raise PermissionError("bridge delivery audience is no longer authorized")
            if self._should_stop or generation != self._generation:
                raise PermissionError("bridge generation changed")
            self._resolve_context(delivery)
            if not self._same_delivery_identity(delivery, self._resolve_context()):
                raise PermissionError("bridge delivery identity changed")
        _active_context.set(delivery)
        return delivery

    def _transfer_authorizer(self, context: BridgeContext):
        """Request-local provider proof, fresh host authorization per chunk.

        Provider membership is refreshed at file boundaries and at most ten
        seconds into a slow transfer. This is never a cached host grant: every
        invocation rechecks actor, binding, epoch and all mapped recipients.
        The provider proof cannot outlive this transfer closure.
        """
        current = self._resolve_context(context)
        generation = self._generation
        refreshed_at = time.monotonic()
        async def authorize():
            nonlocal current, refreshed_at
            if time.monotonic() - refreshed_at >= 10:
                current = await self._prepare_delivery_context(current)
                refreshed_at = time.monotonic()
            await self._authorize_generation(current, generation)
            callback = getattr(self.transport, "authorize_delivery", None)
            if current.conversation_kind != "direct" and (not current.audience_complete or not callable(callback)):
                raise PermissionError("transfer requires a complete authorized audience")
            if callable(callback) and await callback(current) is not True:
                raise PermissionError("transfer audience is no longer authorized")
            await self._authorize_generation(current, generation)
        return authorize

    async def acknowledge_turn(self, target, *, context: BridgeContext) -> bool:
        """Acknowledge only after the normal fresh outbound authorization."""
        if self._delivery_mode != "quiet":
            return False
        current = self._resolve_context(context)
        token = _active_context.set(current)
        try:
            await self.authorize_context(current)
            # Acknowledgements are one validated, bounded line. Calling the
            # guarded primitive keeps authorization failures observable.
            await self.send_text_chunk(target, self._acknowledgement_text)
            return True
        finally:
            _active_context.reset(token)

    async def _authorize_outbound(self) -> None:
        await self._prepare_delivery_context(self._resolve_context())

    async def _ensure_transport_started(self) -> None:
        generation = self._generation
        if self._should_stop:
            raise PermissionError("bridge is stopped")
        async with self._transport_lock:
            if self._should_stop or generation != self._generation:
                raise PermissionError("bridge generation changed")
            if not self._transport_started:
                capabilities = await self.transport.start()
                if self._should_stop or generation != self._generation:
                    await self.transport.stop()
                    raise PermissionError("bridge generation changed during transport startup")
                if not isinstance(capabilities, BridgeCapabilities):
                    await self.transport.stop()
                    raise TypeError("transport must return BridgeCapabilities")
                self._capabilities = capabilities
                self._transport_started = True

    async def _authorize_generation(self, context: BridgeContext, generation: int) -> None:
        await self.authorize_context(context)
        if generation != self._generation:
            raise PermissionError("bridge generation changed")

    async def start(self) -> None:
        current = asyncio.current_task()
        if self._start_task is not None and not self._start_task.done():
            return
        self._start_task = current
        self._should_stop = False
        streak = 0
        try:
            while not self._should_stop:
                try:
                    self._gateway_lost.clear()
                    started = asyncio.get_running_loop().time()
                    await self._ensure_transport_started()
                    await self._run()
                    if self._should_stop:
                        break
                    if self._gateway_lost.is_set():
                        if asyncio.get_running_loop().time() - started >= BRIDGE_GATEWAY_RECONNECT_STABLE_SECONDS:
                            streak = 0
                        streak += 1
                        # Only the explicitly injected adapter reconnects.
                        async with self._transport_lock:
                            await self.transport.stop()
                            self._transport_started = False
                        await asyncio.sleep(self._gateway_reconnect_delay(streak))
                    else:
                        streak = 0
                        await asyncio.sleep(BRIDGE_RETRY_SECONDS)
                except asyncio.CancelledError:
                    break
                except Exception as error:
                    if self._should_stop:
                        break
                    logger.warning("%s bridge intake failed (%s)", self.name, type(error).__name__)
                    await asyncio.sleep(BRIDGE_RETRY_SECONDS)
        finally:
            if self._start_task is current:
                self._start_task = None
            async with self._transport_lock:
                if self._transport_started:
                    await self.transport.stop()
                    self._transport_started = False

    async def stop(self) -> None:
        if not self._should_stop:
            self._generation += 1
        self._should_stop = True
        current = asyncio.current_task()
        tasks = [task for task in self._pending_transports if task is not current and not task.done()]
        if self._start_task is not None and self._start_task is not current and not self._start_task.done():
            tasks.append(self._start_task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        async with self._transport_lock:
            if self._transport_started:
                await self.transport.stop()
                self._transport_started = False

    async def _on_gateway_lost(self) -> None:
        """Compatibility platform hook; no gateway is chosen in embedded mode."""

    @property
    def supported_commands(self) -> tuple[tuple[str, str], ...]:
        from .commands import COMMAND_MAP
        return tuple((item.name, item.description) for item in self._capabilities.commands
                     if item.name not in COMMAND_MAP or COMMAND_MAP[item.name].menu_visible)

    def _input_attachment(self, raw) -> BridgeAttachment:
        if isinstance(raw, BridgeAttachment):
            return raw
        if not isinstance(raw, dict):
            raise TypeError("unsupported input attachment")
        path = raw.get("path") or raw.get("local_path")
        kind = str(raw.get("kind") or raw.get("type") or "file")
        return BridgeAttachment(kind=kind, filename=raw.get("filename") or (Path(path).name if path else "attachment"),
                                mime_type=raw.get("mime_type") or raw.get("mime") or "application/octet-stream",
                                size_bytes=raw.get("size_bytes") or raw.get("size") or 0,
                                artifact_ref=raw.get("artifact_ref") or raw.get("id") or "",
                                local_path=str(path) if path else None, owned=False,
                                provider_attachment_id=raw.get("provider_attachment_id"),
                                sha256=raw.get("sha256"), reader_ref=raw.get("reader_ref"))

    def _platform_attachment(self, attachment: BridgeAttachment) -> Attachment:
        if not attachment.local_path:
            raise ValueError("transport attachment has no managed local delivery artifact")
        path = attachment.local_path
        if attachment.owned:
            info = os.lstat(path)
            if not Path(path).is_symlink():
                expected = self._owned_artifacts.setdefault(path, (info.st_dev, info.st_ino))
                if expected != (info.st_dev, info.st_ino):
                    raise ValueError("owned delivery artifact changed")
        return Attachment(type="voice" if attachment.kind == "audio" else attachment.kind,
                          path=path, filename=attachment.filename, mime_type=attachment.mime_type)

    async def send_message(self, text: str, session_id: str | None = None, *, target=None,
                           on_status=None, on_delta=None, on_compaction=None, input_was_voice=False,
                           source="user_typed", attachments=None, author=None,
                           context: BridgeContext | None = None,
                           history: tuple[BridgeHistoryMessage, ...] | None = None) -> dict:
        generation = self._generation
        current = self._resolve_context(context)
        await self.authorize_context(current)
        await self._ensure_transport_started()
        await self._authorize_generation(current, generation)
        parts = [BridgePart(text=text)]
        for raw in attachments or ():
            attachment = self._input_attachment(raw)
            if attachment.kind not in self._capabilities.input_media:
                raise ValueError("transport does not support this input media kind")
            parts.append(BridgePart(attachment=attachment))
        async def on_event(event: BridgeEvent):
            if not isinstance(event, BridgeEvent):
                raise TypeError("transport must emit BridgeEvent")
            await self._authorize_generation(current, generation)
            if event.kind == "status" and on_status is not None:
                await on_status(event.text)
            elif event.kind in ("text", "delta", "text_delta") and on_delta is not None:
                await on_delta(event.text)
            elif event.kind == "compaction" and on_compaction is not None:
                import json
                try:
                    value = json.loads(event.text)
                except (ValueError, TypeError):
                    value = {"phase": event.text}
                if not isinstance(value, dict):
                    raise TypeError("invalid compaction progress")
                await on_compaction(value)
        hint = _legacy_session_hint.set(session_id)
        target_hint = _legacy_target_hint.set(target)
        reply_target = _legacy_reply_target.set(None)
        task = asyncio.current_task()
        self._pending_transports.add(task)
        try:
            await self._authorize_generation(current, generation)
            current = await self._prepare_delivery_context(current)
            request = BridgeMessage(context=current, parts=tuple(parts), history=tuple(history) if history is not None else _active_history.get(),
                                    source="voice" if input_was_voice or source == "stt" else "text",
                                    presentation=self._personality_directive)
            reply = await self.transport.send(request, on_event=on_event)
            latest_target = _legacy_reply_target.get() if getattr(self.transport, "legacy_markers", False) else None
        finally:
            self._pending_transports.discard(task)
            _legacy_reply_target.reset(reply_target)
            _legacy_target_hint.reset(target_hint)
            _legacy_session_hint.reset(hint)
        if not isinstance(reply, BridgeReply):
            raise TypeError("transport must return BridgeReply")
        await self._authorize_generation(current, generation)
        current = await self._prepare_delivery_context(current)
        legacy = {"type": "duplicate" if reply.status == "coalesced" else "error" if reply.status in ("failed", "cancelled") else "response",
                  "text": "\n".join(part.text for part in reply.parts if part.text is not None),
                  "model": reply.model, "attachments": [], "target": latest_target or target,
                  "_typed_parts": reply.parts}
        if not getattr(self.transport, "legacy_markers", False):
            for part in reply.parts:
                if part.attachment is not None and part.attachment.kind not in self._capabilities.output_media:
                    raise ValueError("transport returned unsupported output media")
        else:
            legacy.pop("_typed_parts")
            legacy["attachments"] = [self._platform_attachment(p.attachment) for p in reply.parts if p.attachment is not None]
        return legacy

    async def dispatch_turn(self, target, session_id: str | None, text: str, *, context: BridgeContext | None = None,
                            history: tuple[BridgeHistoryMessage, ...] = (), voice_detected=False, attachments=None, author=None,
                            acknowledged: bool = False) -> None:
        if type(acknowledged) is not bool:
            raise ValueError("acknowledged must be a boolean")
        current = self._resolve_context(context)
        token = _active_context.set(current)
        history_token = _active_history.set(tuple(history))
        try:
            await self.authorize_context(current)
            await self._dispatch_turn(target, session_id, text, voice_detected=voice_detected, attachments=attachments, author=author, acknowledged=acknowledged)
        finally:
            _active_history.reset(history_token)
            _active_context.reset(token)

    async def transcribe_with_fallback(self, file_path: str, *, context: BridgeContext | None = None,
                                       attachment: BridgeAttachment | None = None) -> str:
        """Use the host speech callback, preserving supplied provider metadata."""
        generation = self._generation
        current = self._resolve_context(context)
        await self.authorize_context(current)
        await self._ensure_transport_started()
        await self._authorize_generation(current, generation)
        if not {"voice", "audio"}.intersection(self._capabilities.input_media):
            return VOICE_FALLBACK
        path = Path(file_path)
        if attachment is None:
            attachment = BridgeAttachment(kind="voice", filename=path.name, mime_type="audio/ogg", size_bytes=path.stat().st_size, local_path=str(path))
        elif (not isinstance(attachment, BridgeAttachment) or attachment.kind not in {"voice", "audio"}
              or attachment.local_path is None or Path(attachment.local_path).resolve() != path.resolve()
              or attachment.size_bytes is not None and attachment.size_bytes != path.stat().st_size):
            raise ValueError("Speech attachment differs from the staged audio")
        await self._authorize_generation(current, generation)
        emit_diagnostic(current, "transcription", "started")
        try:
            text = await self.transport.transcribe(current, attachment)
        except (TimeoutError, RuntimeError):
            await self._authorize_generation(current, generation)
            await self._prepare_delivery_context(current)
            emit_diagnostic(current, "transcription", "unavailable")
            return VOICE_FALLBACK
        await self._authorize_generation(current, generation)
        emit_diagnostic(current, "transcription", "completed" if text else "unavailable")
        return text or VOICE_FALLBACK

    async def transcribe_via_gateway(self, file_path: str, *, context: BridgeContext | None = None) -> str | None:
        text = await self.transcribe_with_fallback(file_path, context=context)
        return None if text == VOICE_FALLBACK else text

    async def synthesise_voice_reply(self, text: str, *, context: BridgeContext | None = None) -> bytes | None:
        attachment = await self._synthesize(text, context=context)
        if attachment is None or not attachment.local_path:
            return None
        try:
            return Path(attachment.local_path).read_bytes()
        finally:
            self._cleanup_owned_temp_artifact(attachment.local_path)

    async def _synthesize(self, text: str, *, context: BridgeContext | None = None) -> BridgeAttachment | None:
        generation = self._generation
        current = self._resolve_context(context)
        await self.authorize_context(current)
        await self._ensure_transport_started()
        await self._authorize_generation(current, generation)
        if not {"voice", "audio"}.intersection(self._capabilities.output_media):
            return None
        attachment = await self.transport.synthesize(current, text)
        if attachment is not None:
            if not isinstance(attachment, BridgeAttachment) or attachment.kind not in ("voice", "audio"):
                raise TypeError("transport must return a voice attachment")
            await self._authorize_generation(current, generation)
            self._platform_attachment(attachment)
        return attachment

    async def synthesise_audio_attachment(self, text: str, *, context: BridgeContext | None = None) -> str | None:
        attachment = await self._synthesize(text, context=context)
        return f"[VOICE:{attachment.local_path}]" if attachment is not None and attachment.local_path else None

    async def send_command_full(self, name: str, session_id: str | None = None, arg: str | None = None, *,
                                context: BridgeContext | None = None, confirmed: bool = False) -> dict:
        generation = self._generation
        current = self._resolve_context(context)
        await self.authorize_context(current)
        await self._ensure_transport_started()
        await self._authorize_generation(current, generation)
        definition = next((item for item in self._capabilities.commands if item.name == name), None)
        if definition is None:
            return {"status": "unsupported", "text": "This command is not supported by this host.", "picker": None}
        if definition.confirmation_required and not confirmed:
            return {"status": "confirmation_required", "text": "This command requires confirmation.", "picker": None}
        hint = _legacy_session_hint.set(session_id)
        task = asyncio.current_task()
        self._pending_transports.add(task)
        try:
            await self._authorize_generation(current, generation)
            current = await self._prepare_delivery_context(current)
            result = await self.transport.command(BridgeCommand(context=current, name=name, argument=arg, confirmed=confirmed))
        finally:
            self._pending_transports.discard(task)
            _legacy_session_hint.reset(hint)
        await self._authorize_generation(current, generation)
        current = await self._prepare_delivery_context(current)
        options = [{"value": option.value, "label": option.label, "subtitle": option.subtitle, "active": option.active}
                   for option in result.options]
        return {"text": "\n".join(p.text for p in result.parts if p.text is not None),
                "status": result.status, "picker": {"options": options, "command": result.picker_command,
                                                       "prompt": result.picker_prompt} if options else None}

    async def _deliver_typed_parts(self, target, parts, *, model=None, voice_detected=False, live=None):
        if voice_detected:
            text = "\n".join(part.text for part in parts if part.text is not None)
            voice = await self._synthesize(text) if text else None
            if voice is not None:
                try:
                    await self.send_attachment(target, self._platform_attachment(voice))
                finally:
                    self._cleanup_owned_temp_artifact(voice.local_path)
        text_indexes = [index for index, part in enumerate(parts) if part.text is not None]
        skip = live.posted_chars if live is not None and live.posted_any else 0
        for index, part in enumerate(parts):
            if part.text is not None:
                text = part.text
                consumed = min(skip, len(text))
                text, skip = text[consumed:], skip - consumed
                clean, _untrusted_markers = parse_response_markers(text)
                if index == (text_indexes[-1] if text_indexes else -1):
                    clean = self.append_model_feedback(clean, model)
                await self.send_response_text(target, clean)
            elif part.attachment is not None:
                attachment = part.attachment
                try:
                    await self.send_attachment(target, self._platform_attachment(attachment))
                finally:
                    self._cleanup_owned_temp_artifact(attachment.local_path)

    async def send_command(self, name: str, session_id: str | None = None, arg: str | None = None, *,
                           context: BridgeContext | None = None, confirmed: bool = False) -> str:
        return (await self.send_command_full(name, session_id, arg, context=context, confirmed=confirmed)).get("text", "")

    def _cleanup_owned_temp_artifact(self, path: str | None) -> None:
        if not path or path not in self._owned_artifacts:
            return
        expected = self._owned_artifacts.pop(path)
        try:
            info = os.lstat(path)
            if (info.st_dev, info.st_ino) == expected and not Path(path).is_symlink():
                os.unlink(path)
        except OSError:
            logger.debug("owned bridge artifact cleanup unavailable")

    @staticmethod
    def append_model_feedback(text: str, model: str | None) -> str:
        """Append a compact model footer to a response body."""
        if not model:
            return text
        footer = f"Model: {model}"
        return f"{text}\n\n{footer}" if text else footer


    @staticmethod
    def _gateway_reconnect_delay(streak: int) -> float:
        """Exponential backoff for repeated gateway-lost reconnects."""
        if streak <= 0:
            return 0.0
        base = max(0.0, BRIDGE_GATEWAY_RECONNECT_BASE_SECONDS)
        cap = max(base, BRIDGE_GATEWAY_RECONNECT_MAX_SECONDS)
        return min(cap, base * (2 ** max(0, streak - 1)))


    async def post_status(self, target, text: str):
        """Start the platform's native "is writing" indicator for the turn.

        Telegram/Discord override this to light the native typing dot
        (kept alive on a background task for the turn's duration) and
        return a handle that ``clear_status`` stops. Platforms with no
        typing primitive (Slack, WhatsApp) return ``None`` and rely on the
        live step messages instead. We deliberately do NOT post a
        ``Thinking…`` placeholder message — the server's reasoning state
        is a boolean flag, not a chat bubble. ``text`` is a legacy hint and
        is ignored by typing-based bridges."""
        return None


    async def update_status(self, handle, text: str) -> None:
        """Deprecated no-op. Tool progress is surfaced as live step
        messages (see ``dispatch_turn`` live mode) and the working state
        as the native typing indicator — there is no placeholder to edit."""
        return None


    async def clear_status(self, handle) -> None:
        """Stop the native typing indicator started by ``post_status``.
        Default no-op for platforms that had no indicator to start."""
        return None


    async def stream_text(self, handle, text: str) -> None:
        """Surface a streaming chunk of the in-flight reply. Default
        is a no-op: bridges that can't edit (WhatsApp) just wait for
        the final reply. Bridges with edit APIs (Telegram, Discord)
        override to update the status message with the accumulated
        text. ``text`` is always the *full accumulated* response so
        far — the bridge doesn't have to maintain its own buffer."""
        return None


    async def post_compaction_notice(self, target):
        """Post the "Compacting conversation" start notice and return a
        handle the terminal edit can target — or ``None``.

        In-place compaction (vision §2) runs a summariser round-trip that
        can take a couple of seconds; this notice explains the pause and
        is the "start" half of the start→outcome pair the user sees.
        Bridges with a message-edit API (Telegram, Discord) override to
        post an editable message and RETURN it, so ``resolve_compaction_notice``
        flips that same bubble to "Compacted conversation" (one
        self-updating message). The default posts a plain start message
        and returns ``None`` — a bridge with no edit API (WhatsApp, Slack)
        then shows the start and the outcome as two short messages.
        """
        try:
            await self.send_text_chunk(target, "🗜 Compacting conversation")
        except Exception:
            pass
        return None


    async def resolve_compaction_notice(
        self, target, handle, text: str, *, ok: bool,
    ) -> None:
        """Resolve the compaction notice started by ``post_compaction_notice``.

        ``handle`` is whatever that method returned. Edit-capable bridges
        override to rewrite the handle's bubble to ``text`` (the outcome).
        The default covers the no-handle case (no edit API): on success it
        posts ``text`` ("Compacted conversation") as the second of the two
        messages; on a skipped fold (``ok=False``) it stays silent — the
        start line already landed and an internal no-op needs no epilogue.
        """
        if handle is not None:
            return  # edit-capable bridges override; the base can't edit
        if ok:
            try:
                await self.send_text_chunk(target, text)
            except Exception:
                pass


    async def run_compact_command(self, target, session_id: str, *, context: BridgeContext | None = None) -> None:
        """Run ``/compact`` with a start→outcome notice on the channel.

        A slash command doesn't flow through a turn collector, so the
        ``session_compacted`` frames the gateway emits during the fold are
        dropped here (they still drive the desktop app's card). We post our
        own notice around the command instead — "Compacting conversation"
        up front, then the concise outcome once it lands — so a manual
        ``/compact`` reads exactly like the automatic path. Callers use
        this in place of the generic ``send_command`` + ``deliver_command_result``
        for the ``compact`` command.
        """
        if context is None:
            await self._authorize_outbound()
        else:
            await self.authorize_context(self._resolve_context(context))
        try:
            handle = await self.post_compaction_notice(target)
        except Exception:
            handle = None
        result = (await self.send_command("compact", session_id=session_id, context=context) or "").strip()
        # The gateway returns a concise "Compacted conversation." on success,
        # or an informative line ("Nothing to compact …" / "Compaction
        # failed …") otherwise — surface whichever it is as the outcome.
        label = f"🗜 {result}" if result else "🗜 Compacted conversation"
        try:
            await self.resolve_compaction_notice(target, handle, label, ok=True)
        except Exception:
            pass


    async def ack_follower(self, target) -> None:
        """Acknowledge a follow-up message that arrived while a turn
        was still in flight. Server-side coalescence already folds it
        into the owner's response, but without a visible ACK the user
        sees their message go unanswered until the merged reply lands
        — that read as "the bot ignored my second message". Bridges
        with a per-message reaction primitive (Telegram, Discord)
        override to flag the message with an emoji; bridges without
        one stay quiet."""
        return None


    async def send_text_chunk(self, target, chunk: str) -> None:
        """Send one already-split chunk of response text. Subclasses
        own platform formatting (HTML render + fallback for Telegram,
        whatsapp markdown, etc.) inside this method."""
        raise NotImplementedError


    async def send_attachment(self, target, att) -> None:
        """Send one ``Attachment`` (image, voice, video, file) to the
        platform. Subclasses dispatch by ``att.type`` as needed."""
        raise NotImplementedError


    async def _dispatch_turn(
        self,
        target,
        session_id: str,
        text: str,
        *,
        voice_detected: bool = False,
        attachments: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None = None,
        author: dict[str, Any] | None = None,
        acknowledged: bool = False,
    ) -> None:
        """Shared orchestration: post status → send_message → render reply.

        Lives here (not in each bridge) so the spam-coalescence
        sentinel, voice-modality mirror, attachment splitting, and
        message-limit chunking all stay in lockstep across Telegram,
        Discord, and WhatsApp. A subclass usually only needs to fill in
        the platform primitives above; the orchestration "just works".
        """
        status_handle = None
        if self._delivery_mode == "quiet" and not acknowledged:
            await self.acknowledge_turn(target, context=self._resolve_context())
        elif self._live:
            try:
                status_handle = await self.post_status(target, "Thinking...")
            except Exception as e:  # noqa: BLE001
                logger.debug("%s: post_status failed (%s)", self.name, type(e).__name__)

        # Live-message mode posts tool calls + narration as separate
        # chat messages as the turn unfolds. Disabled for voice turns:
        # a voice-note user wants the spoken reply, not a wall of
        # intermediate text bubbles (the spoken answer still lands via
        # the normal final-reply path below).
        live_active = self._live and not voice_detected
        live = _LiveProgress() if live_active else None

        async def _live_flush_text(accumulated: str) -> None:
            """Post the span of narration produced since the last flush.

            ``accumulated`` is the raw delta stream so far; we post the
            slice past our high-water mark, advancing the mark even when
            the slice is marker/whitespace-only so it is never re-posted.
            """
            if live is None or not accumulated:
                return
            if len(accumulated) <= live.posted_chars:
                return
            segment = accumulated[live.posted_chars:]
            live.posted_chars = len(accumulated)
            # Strip [IMAGE:]/[FILE:]/… markers from the visible text. We
            # don't send the parsed attachments mid-stream — they're
            # handled once at the end (matches the non-live path).
            seg_clean, _atts = parse_response_markers(segment)
            if seg_clean.strip():
                try:
                    await self.send_response_text(target, seg_clean)
                    live.posted_any = True
                except Exception:
                    pass

        async def on_status(raw: str) -> None:
            if live is not None:
                # Flush narration that preceded this tool call, then post
                # the tool-usage line as its own message. Read the raw
                # accumulated text straight off the collector so it is in
                # frame order (the on_delta callbacks are detached and may
                # lag); fall back to the latest on_delta value otherwise.
                pending = getattr(self, "_stream_pending", None)
                coll = pending.get(session_id) if pending else None
                accumulated = coll.accumulated_text if coll is not None else live.latest
                await _live_flush_text(accumulated)
                line = format_tool_message(raw)
                if line:
                    try:
                        await self.send_text_chunk(target, line)
                        live.posted_any = True
                    except Exception:
                        pass
                return
            if status_handle is None:
                return
            try:
                await self.update_status(status_handle, format_tool_status(raw))
            except Exception:
                pass

        async def on_delta(running_text: str) -> None:
            if live is not None:
                # Keep the latest accumulated text as a fallback for
                # ``on_status`` / the end-of-turn flush. Don't post here —
                # narration is flushed at tool boundaries and at the end
                # so each message is a coherent span, not a token fragment.
                if running_text and len(running_text) > len(live.latest):
                    live.latest = running_text
                return
            if status_handle is None or not running_text:
                return
            try:
                await self.stream_text(status_handle, running_text)
            except Exception:
                pass

        # In-place compaction (vision §2) posts its own lifecycle notice —
        # a distinct meaningful event, so it fires in both live and
        # non-live modes (unlike tool spam). The ``running`` frame opens
        # "Compacting conversation" and stashes the editable handle; the
        # terminal frame flips it to "Compacted conversation" (or resolves
        # a skipped fold). Voice turns opt out — a voice-note user wants
        # the spoken reply, not a text bubble. Deliberately does NOT touch
        # ``live.posted_any``: the notice is orthogonal to reply narration,
        # and marking it posted would suppress the end-of-turn reply render.
        compaction_handle: dict = {"h": None}

        async def on_compaction(data: dict) -> None:
            if voice_detected or not self._live:
                return
            phase = str(data.get("phase") or "done")
            if phase == "running":
                try:
                    compaction_handle["h"] = await self.post_compaction_notice(target)
                except Exception:
                    compaction_handle["h"] = None
                return
            ok = phase != "error"
            label = "🗜 Compacted conversation" if ok else "🗜 Compaction skipped"
            try:
                await self.resolve_compaction_notice(
                    target, compaction_handle["h"], label, ok=ok,
                )
            except Exception:
                pass
            compaction_handle["h"] = None

        # Embedded input is immutable attributed human text. Presentation is
        # separate BridgeMessage metadata, composed by the authorized host.
        outbound_text = text
        if getattr(self.transport, "legacy_markers", False):
            prepare = getattr(self.transport, "prepare_text", None)
            if prepare is not None:
                outbound_text = await prepare(outbound_text)
            # Preserve the standalone legacy gateway's historical prompt path.
            outbound_text = (
                "[Respond in the user's own language, mirroring whatever "
                "they write. If they mix languages, follow the most recent "
                "message.]\n\n"
            ) + outbound_text
            if self._personality_directive:
                outbound_text = (
                    f"[Persona for this reply: {self._personality_directive}]\n\n"
                    f"{outbound_text}"
                )
        # NOTE: the vault-save reminder and the auto-skills matcher used to be
        # injected here, bridge-side. Both are gone from this path:
        #
        #  • The reminder now hooks ``core/agent.py``'s ``_run_inner`` /
        #    ``_run_inner_stream``, which EVERY origin funnels through — chat,
        #    scheduler, delegation, workflow, events. Injecting it here meant
        #    only bridge-mediated conversations could ever get it, so a
        #    desktop/gateway-only install got no nudge at all. Vision §15: "no
        #    reduced or alternate baseline for non-interactive execution
        #    paths". This path's copy also re-implemented the enabled check
        #    with the wrong default, which is what kept the feature off
        #    everywhere; see ``learning/vault_reminder.py``.
        #  • The skills matcher is deleted outright — it read a table nothing
        #    could write (its Groq-hardcoded detector had zero callers), and a
        #    markdown how-to belongs in the vault, not an opaque parallel
        #    store. See ``learning/__init__.py``.

        try:
            response = await self.send_message(
                outbound_text, session_id,
                target=target,
                on_status=on_status,
                on_delta=on_delta,
                on_compaction=on_compaction,
                # Voice notes bypass the typed-burst coalescence window
                # for instant barge-in (StreamSession STT-bypass path).
                source="stt" if voice_detected else "user_typed",
                attachments=attachments,
                author=author,
            )
        except Exception as e:  # noqa: BLE001
            # Hard failure of the gateway round-trip (network drop,
            # protocol error, etc.). The user previously saw nothing
            # because the exception bubbled past the dispatch loop and
            # got swallowed at the bridge boundary; surface a friendly
            # one-liner so they know something happened.
            logger.warning("%s dispatch_turn send_message failed (%s)", self.name, type(e).__name__)
            elog(
                "bridge.dispatch_error",
                bridge=self.name,
                error_type=type(e).__name__,
            )
            response = {
                "type": "error",
                "text": "The host could not complete this channel request.",
                "model": None,
                "attachments": [],
                "target": target,
            }
        finally:
            if status_handle is not None:
                try:
                    await self.clear_status(status_handle)
                except Exception:
                    pass

        # Concurrent message in the same burst — the owner posts the
        # merged reply; followers exit so the user sees ONE response.
        if response.get("type") == "duplicate":
            # Tell the user we saw the follow-up so they don't think
            # the bot ignored their second message. Bridge-specific
            # primitive (Telegram → 👀 reaction; others no-op).
            try:
                await self.ack_follower(target)
            except Exception:
                pass
            return

        # Soft errors carried back by the gateway (model said "no",
        # MCP died mid-turn, etc.) land here as ``type=error``. Replace
        # the raw error text — which is often a stack trace or a JSON
        # payload — with a friendly + actionable message and bail out
        # before the normal attachment / chunking path tries to render
        # it as a regular reply.
        if response.get("type") == "error":
            err_text = ((response.get("text") or "").strip() if getattr(self.transport, "legacy_markers", False)
                        else "The host could not complete this channel request.")
            preview = err_text[:300] if err_text else "errore non noto"
            user_msg = (
                "⚠️ Ho avuto un problema a elaborare il messaggio.\n\n"
                f"Dettagli: {preview}\n\n"
                "Riprova tra qualche istante. Se continua, prova `/clear` "
                "per ricominciare la conversazione."
            )
            try:
                await self.send_response_text(target, user_msg)
            except Exception:
                pass
            return

        # Anchor the merged reply to the LATEST message the burst saw,
        # not the FIRST. Without this, a 5-message spam visibly replies
        # to bubble #1 — looks like the bot is "answering an old
        # message". send_message stashed each follower's target on the
        # collector; the owner's reply now reads back the latest.
        post_target = response.get("target") or target

        if "_typed_parts" in response:
            await self._deliver_typed_parts(post_target, response["_typed_parts"], model=response.get("model"),
                                            voice_detected=voice_detected, live=live)
            return

        outbound_attachments = self._coerce_response_attachments(
            response.get("attachments") or (),
        )
        marker_attachments: list[Attachment] = []

        if live is not None and live.posted_any:
            # Live mode already streamed the tool calls + narration as
            # their own messages. Post ONLY the still-unposted tail (the
            # final answer) so nothing is duplicated. ``accumulated`` is
            # the raw delta stream; ``posted_chars`` is how much of it we
            # already sent. Voice mirroring is off in live mode, and
            # agent-emitted attachment markers are dropped here exactly as
            # the non-live path drops them — only the visible text shows.
            accumulated = response.get("accumulated")
            if accumulated is None:
                remainder_raw = response.get("text", "") or ""
            elif live.posted_chars < len(accumulated):
                remainder_raw = accumulated[live.posted_chars:]
            else:
                remainder_raw = ""
            clean, marker_attachments = parse_response_markers(remainder_raw)
            if not getattr(self.transport, "legacy_markers", False):
                marker_attachments = []
            clean = clean.strip()
            if clean:
                clean = self.append_model_feedback(clean, response.get("model"))
                await self.send_response_text(post_target, clean)
        else:
            response_text = response.get("text", "") or ""
            response_text = await self.maybe_prepend_voice_reply(response_text, voice_detected)

            clean, marker_attachments = parse_response_markers(response_text)
            if not getattr(self.transport, "legacy_markers", False):
                marker_attachments = []

            clean = self.append_model_feedback(clean, response.get("model"))
            await self.send_response_text(post_target, clean)

        # Native ``OutTextFinal.attachments`` is now the canonical path.  The
        # marker list remains as a compatibility fallback and for the locally
        # synthesised voice reply.  Send in stable order, de-duplicating a
        # marker already represented by its persisted AttachmentRef.
        seen: set[tuple[str, str]] = set()
        for att in [*outbound_attachments, *marker_attachments]:
            identity = (att.type, os.path.realpath(att.path))
            if identity in seen:
                continue
            seen.add(identity)
            try:
                await self.send_attachment(post_target, att)
            except Exception as e:  # noqa: BLE001
                logger.error("%s attachment send failed (%s)", self.name, type(e).__name__)
            finally:
                self._cleanup_owned_temp_artifact(att.path)


    @staticmethod
    def _coerce_response_attachments(raw_items: Any) -> list[Attachment]:
        """Translate wire AttachmentRefs into the channel adapter shape."""

        out: list[Attachment] = []
        if not isinstance(raw_items, (list, tuple)):
            return out
        for raw in raw_items:
            if isinstance(raw, Attachment):
                out.append(raw)
                continue
            if not isinstance(raw, dict):
                continue
            path = str(raw.get("path") or "").strip()
            if not path:
                # External bridges run beside the gateway and therefore use
                # the canonical local CAS path. A URL-only ref is useful to a
                # remote app but cannot be handed to a platform SDK as a file.
                continue
            kind = str(raw.get("type") or raw.get("kind") or "file").lower()
            if kind not in {"image", "file", "voice", "video"}:
                kind = "file"
            out.append(Attachment(
                type=kind,
                path=path,
                filename=str(raw.get("filename") or Path(path).name),
                mime_type=raw.get("mime_type") or raw.get("mime"),
                caption=raw.get("caption"),
            ))
        return out


    async def send_response_text(self, target, text: str) -> None:
        """Split ``text`` at ``message_limit`` and send each chunk.

        Shared by ``dispatch_turn`` and command handlers (``/clear``,
        ``/help``) so a long command result obeys the same chunking +
        per-platform rendering as a normal reply. Also peels off any
        ``[CHOICE: a | b | c]`` marker the model emitted — the visible
        text loses the marker, and the options become an inline
        keyboard via ``send_choice_buttons`` (no-op on platforms that
        can't render one).
        """
        if not text:
            return
        clean_text, choice_options = _extract_choice_marker(text)
        for chunk in split_preserving_code_blocks(clean_text, self.message_limit):
            try:
                await self.send_text_chunk(target, chunk)
            except Exception as e:  # noqa: BLE001
                logger.error("%s text send failed (%s)", self.name, type(e).__name__)
        if choice_options:
            try:
                await self.send_choice_buttons(target, choice_options)
            except Exception as e:  # noqa: BLE001
                logger.warning("%s choice button send failed (%s)", self.name, type(e).__name__)


    async def send_choice_buttons(self, target, options: list[str]) -> None:
        """Render an inline picker for ``options``. Default no-op — only
        bridges with a button primitive (Telegram, Discord) override.
        WhatsApp, Slack-thread-only deployments etc. just drop the
        buttons and rely on the user to type one of the options
        back as plain text."""
        return None


    async def maybe_prepend_voice_reply(
        self, text: str, voice_detected: bool,
    ) -> str:
        """Mirror modality: voice-in → voice-out attachment.

        When the inbound message was voice and we have a non-empty text
        reply, synthesize the reply to MP3 and prepend the
        ``[VOICE:/path]`` marker. Errors during synthesis are logged
        and swallowed — the user still gets the text reply. Used by
        every bridge so the voice-out logic lives in one place.
        """
        if not (voice_detected and text):
            return text
        try:
            voice_marker = await self.synthesise_audio_attachment(text)
        except Exception as e:  # noqa: BLE001 — never drop the text on synth failure
            elog(
                f"{self.name}.tts.error",
                level="warning",
                error_type=type(e).__name__,
            )
            return text
        if not voice_marker:
            return text
        return f"{voice_marker}\n{text}"


    async def render_picker(self, target, picker: dict) -> bool:
        """Render a structured command picker (``command_result.picker``)
        as native interactive UI (inline keyboard / select menu).

        Returns ``True`` when the platform rendered an interactive picker,
        ``False`` when it can't — in which case :meth:`deliver_command_result`
        falls back to the plain-text option list. Default is ``False`` (no
        button primitive). Telegram, Discord, WhatsApp and Slack override.
        """
        return False


    async def deliver_command_result(self, target, result: dict) -> None:
        """Send a command result to ``target``, preferring an interactive
        picker when one is present and the platform can render it.

        Command handlers call this instead of ``send_response_text`` so the
        model chooser (and any future pickable command) shows buttons where
        possible and degrades to the text list everywhere else.
        """
        if not isinstance(result, dict):
            return await self.send_response_text(target, str(result))
        picker = result.get("picker")
        if isinstance(picker, dict) and picker.get("options"):
            try:
                if await self.render_picker(target, picker):
                    return
            except Exception as e:  # noqa: BLE001
                logger.warning("%s render_picker failed (%s)", self.name, type(e).__name__)
        await self.send_response_text(target, result.get("text", ""))


    async def _run(self) -> None:
        """Platform-specific polling loop. Override in subclass."""
        raise NotImplementedError
