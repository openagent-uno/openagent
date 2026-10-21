"""Standalone gateway transport. Not part of the embeddable bridge wheel."""
from __future__ import annotations
import asyncio
import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Callable, Awaitable
from openagent_core.media import Attachment
from openagent_core.stream.collector import StreamCollector, fold_outbound_event
from openagent_core.stream.events import SessionOpen, TextFinal, now_ms
from openagent_client_transport.stream.wire import SESSION_COMPACTED, event_to_wire, wire_to_event
from openagent_server.gateway import protocol as P
from openagent_channel_bridges.base import (VOICE_FALLBACK, BRIDGE_COALESCE_WINDOW_MS,
    resolve_personality_directive, _legacy_session_hint, _legacy_target_hint, _legacy_reply_target, elog)
from openagent_channel_bridges.contracts import (BridgeAttachment, BridgeCapabilities, BridgeCommandDefinition,
    BridgeCommandResult, BridgeEvent, BridgePart, BridgeReply, BridgePickerOption)
from openagent_channel_bridges.commands import COMMAND_SPECS
from openagent_channel_bridges.history import render_history
logger = logging.getLogger(__name__)
BRIDGE_WS_HEARTBEAT_SECONDS = 30
BRIDGE_GATEWAY_LOSS_GRACE_SECONDS = float(os.environ.get("OPENAGENT_BRIDGE_GATEWAY_LOSS_GRACE_SECONDS", "55"))

class _DBShim:
    __slots__ = ("_conn",)
    def __init__(self, conn): self._conn = conn

class GatewayBridgeTransport:
    legacy_markers = True
    name = "bridge"

    def bind_bridge(self, bridge):
        self._bridge = bridge
        self.name = bridge.name

    @property
    def loss_event(self):
        return self._gateway_lost

    async def authorize_context(self, context):
        bridge = getattr(self, "_bridge", None)
        binding = getattr(bridge, "binding_id", None)
        return (context.provider == self.name and (binding is None or binding == context.binding_id))

    async def authorize_delivery(self, context):
        # The legacy gateway has no audience-wide capability policy. Never
        # substitute actor admission for approval to disclose into a group.
        return (getattr(context, "conversation_kind", "unknown") == "direct"
                and await self.authorize_context(context))

    async def start(self):
        self._should_stop = False
        self._gateway_lost.clear()
        await self._connect_gateway()
        return BridgeCapabilities(commands=tuple(BridgeCommandDefinition(spec.name, spec.description) for spec in COMMAND_SPECS),
                                  input_media=("image", "file", "voice", "audio", "video"),
                                  output_media=("image", "file", "voice", "audio", "video"),
                                  progress_kinds=("status", "text", "compaction"))

    async def _on_gateway_lost(self):
        bridge = getattr(self, "_bridge", None)
        if bridge is not None:
            await bridge._on_gateway_lost()

    def _session_for_context(self, context):
        hint = _legacy_session_hint.get()
        # Real typed ingress never keys collectors by a channel-only hint.
        # The old untyped BaseBridge adapter retains its literal session key;
        # current provider callbacks carry account/actor/thread explicitly.
        data = json.dumps((context.binding_id, context.provider, context.account_id, context.actor_id,
                           context.conversation_id, context.thread_id, hint), separators=(",", ":"))
        return f"{context.provider}:{hashlib.sha256(data.encode()).hexdigest()}"

    async def prepare_text(self, text):
        from openagent_core.core.hooks import expand_quick_command
        return expand_quick_command(text) or text

    async def send(self, request, *, on_event=None):
        if not await self.authorize_context(request.context):
            raise PermissionError("gateway bridge context changed")
        text = "\n".join(part.text for part in request.parts if part.text is not None)
        history = render_history(request.history)
        if history:
            text = f"{history}\n\nCurrent message:\n{text}"
        attachments = []
        for part in request.parts:
            attachment = part.attachment
            if attachment is not None:
                if not attachment.local_path:
                    raise ValueError("gateway input attachment requires managed local path")
                attachments.append({"type": attachment.kind, "path": attachment.local_path,
                                    "filename": attachment.filename, "mime_type": attachment.mime_type,
                                    "size_bytes": attachment.size_bytes})
        async def emit(kind, text):
            if on_event is not None:
                await on_event(BridgeEvent(kind=kind, text=text))
        response = await self._legacy_send_message(text, self._session_for_context(request.context),
            target=_legacy_target_hint.get(), on_status=lambda text: emit("status", text),
            on_delta=lambda text: emit("text", text),
            on_compaction=lambda value: emit("compaction", json.dumps(value)),
            source="stt" if request.source == "voice" else "user_typed", attachments=attachments,
            author={"kind": "human", "handle": f"{request.context.provider}:{request.context.actor_id}",
                    "display": request.context.actor_id})
        _legacy_reply_target.set(response.get("target"))
        parts = []
        if response.get("text"):
            parts.append(BridgePart(text=response["text"]))
        for raw in response.get("attachments") or ():
            path = getattr(raw, "path", None) if isinstance(raw, Attachment) else raw.get("path")
            if not path:
                continue
            def field(name, default=None):
                return getattr(raw, name, default) if isinstance(raw, Attachment) else raw.get(name, default)
            parts.append(BridgePart(attachment=BridgeAttachment(kind=field("type", "file"), filename=field("filename") or Path(path).name,
                local_path=path, mime_type=field("mime_type") or "application/octet-stream")))
        status = "coalesced" if response.get("type") == "duplicate" else "failed" if response.get("type") == "error" else "completed"
        return BridgeReply(parts=tuple(parts), status=status, model=response.get("model"), session_ref=self._session_for_context(request.context))

    async def command(self, request):
        if not await self.authorize_context(request.context):
            raise PermissionError("gateway bridge context changed")
        result = await self._legacy_command_full(request.name, self._session_for_context(request.context), request.argument)
        picker = result.get("picker") or {}
        options = []
        for option in picker.get("options") or ():
            if isinstance(option, dict):
                options.append(BridgePickerOption(value=str(option.get("value") or ""), label=str(option.get("label") or option.get("value") or ""),
                    subtitle=option.get("subtitle"), active=bool(option.get("active"))))
            else:
                options.append(BridgePickerOption(value=str(option), label=str(option)))
        return BridgeCommandResult(status="failed" if result.get("type") == "error" else "completed",
            parts=(BridgePart(text=result.get("text") or ""),), options=tuple(options),
            picker_command=picker.get("command"), picker_prompt=picker.get("prompt"))

    async def transcribe(self, context, attachment):
        if not await self.authorize_context(context):
            raise PermissionError("gateway bridge context changed")
        if attachment.local_path is None:
            return None
        return await self.transcribe_with_fallback(attachment.local_path)

    async def synthesize(self, context, text):
        if not await self.authorize_context(context):
            raise PermissionError("gateway bridge context changed")
        marker = await self.synthesise_audio_attachment(text)
        if not marker:
            return None
        path = marker[len("[VOICE:"):-1]
        return BridgeAttachment(kind="voice", filename=Path(path).name, mime_type="audio/mpeg",
                                size_bytes=Path(path).stat().st_size, local_path=path, owned=True)

    def __init__(
        self,
        gateway_url: str = "ws://localhost:8765/ws",
        gateway_token: str | None = None,
        personality: str | None = None,
        live: bool = True,
    ):
        self.gateway_url = gateway_url
        self.gateway_token = gateway_token
        # Resolved personality directive (already mapped through presets);
        # ``None`` means no overlay. Wired into ``dispatch_turn`` so every
        # user message picks it up automatically.
        self._personality_directive = resolve_personality_directive(personality)
        self._live = bool(live)
        self._ws = None
        self._ws_session = None  # aiohttp.ClientSession — must be closed
        self._http_session = None  # cached aiohttp.ClientSession for TTS/STT
        self._listener_task: asyncio.Task | None = None
        self._should_stop = False
        self._gateway_lost = asyncio.Event()
        self._gateway_generation = 0
        self._gateway_loss_cleanup_task: asyncio.Task | None = None
        self._command_future: asyncio.Future | None = None
        self._command_lock = asyncio.Lock()
        # NOTE: there is no ``_delta_callbacks`` field. Bridges run in
        # answer-response mode — the gateway streams deltas server-side
        # (the web app consumes them), but bridges only forward the
        # final ``RESPONSE`` text. If a future bridge wants progressive
        # editing it can subclass and tap the WS directly; we don't
        # carry dead infrastructure for a hypothetical caller.
        # ``_stream_opened`` tracks which session_ids have already
        # been ``session_open``'d on the current WS. Reconnects clear this
        # cache so future turns re-send the idempotent SessionOpen frame.
        # ``_stream_pending`` maps session_id → in-flight collector;
        # the listener writes events into it via ``fold_outbound_event``,
        # ``send_message`` awaits ``collector.done``. The tool-status
        # callback lives ON the collector so it dies with the collector
        # (no stale per-session callback dict to keep in sync).
        self._stream_opened: set[str] = set()
        self._stream_pending: dict[str, StreamCollector] = {}
        # Cached aiosqlite connection used by the per-turn skills matcher.
        # Opened lazily on first turn after the feature is enabled, kept
        # alive for the lifetime of the bridge process. WAL journaling on
        # the agent-owned connection lets this run concurrently without
        # blocking writes.
        self._learning_conn = None  # type: ignore[var-annotated]


    async def stop(self) -> None:
        elog("bridge.stop", name=self.name)
        self._should_stop = True
        self._cancel_gateway_loss_cleanup()
        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except (asyncio.CancelledError, Exception):
                pass
            self._listener_task = None
        self._resolve_orphaned_futures("Bridge stopped")
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._ws_session:
            await self._ws_session.close()
            self._ws_session = None
        if self._http_session:
            await self._http_session.close()
            self._http_session = None
        if self._learning_conn is not None:
            try:
                await self._learning_conn.close()
            except Exception:
                pass
            self._learning_conn = None


    async def _get_learning_db_shim(self):
        """Return a duck-typed DB shim over the agent's SQLite file, opening
        the aiosqlite connection on first use and reusing it thereafter.
        Returns ``None`` when the connection can't be opened — callers treat
        that as "unavailable, fall through cleanly".

        Sole remaining caller is Telegram's ``/export``. It was originally
        opened for the bridge-side skill matcher, which is gone (see the note
        in ``_send_and_reply``); the export's own reads of ``user_profiles`` /
        ``skills`` now hit tables with no writer and return empty payloads —
        as they have since those tables were introduced.
        """
        if self._learning_conn is not None:
            return _DBShim(self._learning_conn)
        try:
            import aiosqlite
            from openagent_core.core.paths import default_db_path
            conn = await aiosqlite.connect(str(default_db_path()), timeout=5.0)
            conn.row_factory = aiosqlite.Row
            # Match the agent-owned connection's WAL setting so reads
            # don't block on its in-flight writes.
            await conn.execute("PRAGMA busy_timeout = 5000")
            self._learning_conn = conn
            return _DBShim(conn)
        except Exception as e:
            elog("bridge.learning_db_open_failed", name=self.name, error=str(e)[:120])
            return None


    def _resolve_orphaned_futures(self, reason: str) -> None:
        """Resolve all pending futures with an error so callers don't hang."""
        # Drain any in-flight stream collectors with an error and unblock
        # the awaiters.
        orphaned_streams = list(self._stream_pending.items())
        self._stream_pending.clear()
        for sid, collector in orphaned_streams:
            collector.errored = True
            collector.error_text = reason
            collector.done.set()
            logger.warning("Resolved orphaned stream for %s: %s", sid, reason)
        # The gateway tears down the server-side StreamSessions on the
        # WS drop too, so any cached "we already opened it" bookkeeping
        # is stale — wipe it so the next message re-sends session_open.
        self._stream_opened.clear()
        if self._command_future and not self._command_future.done():
            self._command_future.set_result({"type": "error", "text": reason})
        self._command_future = None


    def _cancel_gateway_loss_cleanup(self) -> None:
        task = self._gateway_loss_cleanup_task
        self._gateway_loss_cleanup_task = None
        if task is not None and not task.done():
            task.cancel()


    @staticmethod
    def _gateway_loss_grace_seconds():
        return BRIDGE_GATEWAY_LOSS_GRACE_SECONDS

    def _schedule_gateway_loss_cleanup(self, reason: str, generation: int) -> None:
        """Fail pending bridge waits only if reconnect does not arrive soon."""
        self._cancel_gateway_loss_cleanup()
        if not self._stream_pending and self._command_future is None:
            return

        async def _cleanup() -> None:
            try:
                await asyncio.sleep(max(0.0, self._gateway_loss_grace_seconds()))
                if self._should_stop or self._gateway_generation != generation:
                    return
                elog(
                    "bridge.gateway_loss_grace_expired",
                    level="warning",
                    name=self.name,
                    pending_streams=len(self._stream_pending),
                )
                self._resolve_orphaned_futures(reason)
            except asyncio.CancelledError:
                return

        self._gateway_loss_cleanup_task = asyncio.create_task(
            _cleanup(), name=f"{self.name}:gateway-loss-cleanup"
        )


    async def _send_gateway_json(self, payload: dict) -> None:
        """Write to the gateway websocket, tolerating reconnect races."""
        if self._ws is None or getattr(self._ws, "closed", False):
            raise ConnectionError("Gateway websocket is not connected")
        try:
            await self._ws.send_json(payload)
        except Exception as e:
            if "closing transport" in str(e).lower():
                raise ConnectionError("Gateway websocket is closing") from e
            raise


    async def _connect_gateway(self) -> None:
        """Connect to the Gateway WebSocket and authenticate."""
        import aiohttp

        # SessionOpen is idempotent on the gateway. Clear the bridge-side cache
        # on every new WS so future turns reannounce their session metadata, but
        # keep in-flight collectors alive while the gateway rebinds them.
        self._stream_opened.clear()

        # Close any previous session/ws from a prior connection attempt
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._ws_session:
            await self._ws_session.close()
            self._ws_session = None

        session = aiohttp.ClientSession()
        self._ws_session = session
        self._ws = await session.ws_connect(
            self.gateway_url,
            heartbeat=BRIDGE_WS_HEARTBEAT_SECONDS,
        )

        # Authenticate
        auth_msg = {"type": P.AUTH, "token": self.gateway_token or "", "client_id": f"bridge:{self.name}"}
        await self._send_gateway_json(auth_msg)

        # Wait for auth response
        resp = await self._ws.receive_json()
        if resp.get("type") == P.AUTH_ERROR:
            raise ConnectionError(f"Gateway auth failed: {resp.get('reason')}")
        logger.info("%s bridge connected to Gateway", self.name)

        # Start response listener — store the task so exceptions are not lost
        self._listener_task = asyncio.create_task(
            self._listen_gateway(), name=f"{self.name}:gw-listener"
        )
        self._gateway_generation += 1
        self._cancel_gateway_loss_cleanup()


    async def _listen_gateway(self) -> None:
        """Listen for Gateway responses and dispatch to pending collectors."""
        import aiohttp
        exit_kind = "normal"
        last_msg_type: str | None = None
        try:
            async for msg in self._ws:
                last_msg_type = msg.type.name if hasattr(msg.type, "name") else str(msg.type)
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle_gateway_frame(json.loads(msg.data))
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    exit_kind = last_msg_type or "closed_or_error"
                    break
        except Exception as e:  # noqa: BLE001
            # Capturing here (not just relying on the silent ``finally``) so
            # the next reproduction has the exception type + traceback. The
            # bridge's ``start()`` retry loop only sees the orphan-future
            # reason string, which strips the exception type and frame info
            # — that's how the v0.12.50+ deflate-error class went undiagnosed
            # for so long: the WS died, futures were orphaned, no one logged
            # what actually killed the listener.
            exit_kind = f"exception:{type(e).__name__}"
            logger.warning("%s bridge gateway listener died (%s)", self.name, type(e).__name__)
            elog(
                "bridge.listener_died", level="error", name=self.name,
                error_type=type(e).__name__,
                last_msg_type=last_msg_type,
            )
        finally:
            elog("bridge.listener_exit", name=self.name, exit_kind=exit_kind)
            generation = self._gateway_generation
            if not self._should_stop:
                self._schedule_gateway_loss_cleanup(
                    "Gateway connection lost",
                    generation,
                )
                self._gateway_lost.set()
                try:
                    await self._on_gateway_lost()
                except Exception as e:  # noqa: BLE001
                    logger.warning("%s gateway-loss hook failed: %s", self.name, e)
            else:
                self._resolve_orphaned_futures("Bridge stopped")


    async def _handle_gateway_frame(self, data: dict) -> None:
        """Route a single decoded WS frame.

        Stream events go through ``wire_to_event`` + ``fold_outbound_event``
        so the per-bridge code stays in lockstep with the wire codec
        (anything new added to ``OutTextFinal`` / ``OutAudio*`` lands
        here automatically). Side-channels (``status`` for tool pings,
        ``command_result`` for command futures) bypass the typed event
        path because they're not part of a turn's outbound stream.
        """
        t = data.get("type")
        sid = data.get("session_id")
        collector = self._stream_pending.get(sid) if sid else None

        if t == P.STATUS:
            cb = collector.on_status if collector is not None else None
            if cb is not None:
                try:
                    await cb(data.get("text", ""))
                except Exception:
                    pass
            return

        if t == SESSION_COMPACTED:
            # In-place compaction progress (vision §2). Route the raw frame
            # to the collector's compaction sink so ``dispatch_turn`` can
            # post the "Compacting conversation" → "Compacted conversation"
            # notice. Not part of the folded reply, so it never touches
            # ``fold_outbound_event`` / the ``done`` latch.
            cb = collector.on_compaction if collector is not None else None
            if cb is not None:
                try:
                    await cb(data)
                except Exception:
                    pass
            return

        if t == P.COMMAND_RESULT:
            if self._command_future and not self._command_future.done():
                self._command_future.set_result(data)
                self._command_future = None
            return

        if t == P.ERROR and collector is None:
            # Bare gateway errors (auth, handshake, no session attached)
            # would otherwise vanish — surface them so the operator sees
            # the root cause in logs.
            logger.warning(
                "%s: gateway error (no session): %s",
                self.name, data.get("text"),
            )
            return

        evt = wire_to_event(data)
        if evt is None or collector is None:
            return
        if fold_outbound_event(collector, evt):
            collector.done.set()


    async def _legacy_send_message(
        self,
        text: str,
        session_id: str,
        *,
        target: Any = None,
        on_status: Callable[[str], Awaitable[None]] | None = None,
        on_delta: Callable[[str], Awaitable[None]] | None = None,
        on_compaction: Callable[[dict], Awaitable[None]] | None = None,
        input_was_voice: bool = False,
        source: str = "user_typed",
        attachments: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None = None,
        author: dict[str, Any] | None = None,
    ) -> dict:
        """Push ``text`` into the user's stream session and await the reply.

        Each ``session_id`` maps to one server-side
        :class:`StreamSession`. Concurrency is handled by ownership: the
        first concurrent caller for a session creates the collector and
        awaits the reply (the OWNER); subsequent callers send their
        ``text_final`` so the gateway folds them into the same merged
        turn, then return a ``{"type":"duplicate"}`` sentinel so the
        bridge skips posting a redundant response. Without this, three
        concurrent messages would each create their own collector,
        overwriting ``_stream_pending[session_id]`` — the first two
        ``send_message`` calls would hang forever waiting for a
        ``turn_complete`` that's now routed to the third caller's
        collector. Voice notes (``source="stt"``) still bypass server
        coalescence for instant barge-in.

        ``target`` is the platform-specific reply anchor (Telegram
        ``Message`` etc.). Both owner and followers stash it on the
        owner's collector so the merged reply gets posted against the
        LATEST message — without this, the bot visibly replies to the
        FIRST message in the burst, looking like it's "answering an
        old message".
        """
        if session_id not in self._stream_opened:
            await self._send_gateway_json(event_to_wire(SessionOpen(
                session_id=session_id,
                ts_ms=now_ms(),
                profile="batched",
                speak=False,
                client_kind=self.name,
                client_capabilities={
                    "attachments": True,
                    "ordered_parts": False,
                    "inline_ui": False,
                    "sidebar_ui": False,
                    "custom_ui_version": 0,
                },
                coalesce_window_ms=BRIDGE_COALESCE_WINDOW_MS,
            )))
            self._stream_opened.add(session_id)

        # Atomic ownership check — synchronous, no awaits between read
        # and write so two concurrent tasks can't both win. A collector
        # whose ``done`` is already set is in its post-turn cleanup
        # window; treat it as no-owner so a fresh message starts a new
        # turn instead of latching onto a corpse and overwriting the
        # owner's ``latest_target`` after it's been read.
        existing = self._stream_pending.get(session_id)
        is_owner = (existing is None) or existing.done.is_set()
        if is_owner:
            collector = StreamCollector()
            collector.on_status = on_status
            collector.on_delta = on_delta
            collector.on_compaction = on_compaction
            self._stream_pending[session_id] = collector
        else:
            collector = existing

        # Both owner and followers contribute their target so the owner
        # posts the merged reply against the most-recent message — see
        # docstring rationale. Skip once the collector has fired its
        # ``done`` event so a late follower can't poison the OWNER's
        # already-finalised target read.
        if target is not None and not collector.done.is_set():
            collector.latest_target = target

        try:
            await self._send_gateway_json(event_to_wire(TextFinal(
                session_id=session_id,
                ts_ms=now_ms(),
                text=text,
                source=source,  # type: ignore[arg-type]
                attachments=tuple(attachments or ()),
                author=author,
            )))
        except Exception:
            if is_owner and self._stream_pending.get(session_id) is collector:
                self._stream_pending.pop(session_id, None)
            raise

        if not is_owner:
            # Follower: text_final has been pushed into the gateway's
            # coalescence buffer. The owner's collector will receive the
            # merged response. Return immediately so the bridge skips
            # posting a duplicate reply.
            return {
                "type": "duplicate",
                "text": "",
                "model": None,
                "attachments": [],
                "target": None,
            }

        try:
            await collector.done.wait()
            return collector.to_legacy_reply()
        finally:
            # Owner cleanup — but only if the slot still holds OUR
            # collector (a brand-new turn could have replaced it after
            # our ``done`` fired).
            if self._stream_pending.get(session_id) is collector:
                self._stream_pending.pop(session_id, None)


    def _http_base(self) -> str:
        """Map ``ws://host:port/ws`` → ``http://host:port`` (or wss/https)."""
        gw = self.gateway_url or ""
        scheme_map = {"ws://": "http://", "wss://": "https://"}
        for ws_prefix, http_prefix in scheme_map.items():
            if gw.startswith(ws_prefix):
                base = http_prefix + gw[len(ws_prefix):]
                break
        else:
            base = gw
        return base[:-3] if base.endswith("/ws") else base


    async def _audio_session(self):
        """Long-lived ``aiohttp.ClientSession`` for TTS/STT round-trips.

        Created lazily (so importing this module doesn't require aiohttp)
        and reused across calls. ``stop()`` closes it.
        """
        if self._http_session is None:
            try:
                import aiohttp
            except ImportError:
                return None
            self._http_session = aiohttp.ClientSession()
        return self._http_session


    def _auth_headers(self, content_type: str | None = None) -> dict[str, str]:
        h: dict[str, str] = {}
        if content_type:
            h["Content-Type"] = content_type
        if self.gateway_token:
            h["Authorization"] = f"Bearer {self.gateway_token}"
        return h


    async def transcribe_via_gateway(self, file_path: str) -> str | None:
        """POST audio to ``/api/stt/transcribe``; ``None`` on any failure."""
        import aiohttp
        from pathlib import Path as _Path

        session = await self._audio_session()
        if session is None:
            return None
        url = f"{self._http_base()}/api/stt/transcribe"
        try:
            with open(file_path, "rb") as fh:
                form = aiohttp.FormData()
                form.add_field(
                    "file", fh,
                    filename=_Path(file_path).name,
                    content_type="audio/ogg",
                )
                async with session.post(
                    url, data=form, headers=self._auth_headers(),
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status != 200:
                        return None
                    body = await resp.json()
                    return (body.get("text") or "").strip() or None
        except FileNotFoundError:
            return None
        except Exception as e:  # noqa: BLE001
            logger.debug("%s.stt.http_exc: %s", self.name, e)
            return None


    async def transcribe_with_fallback(self, file_path: str) -> str:
        """Transcribe ``file_path``: gateway STT first, local Whisper
        fallback, ``VOICE_FALLBACK`` if both produce nothing.

        Used by every bridge for inbound voice notes — keeps the
        gateway-vs-local routing logic in one place. When both paths
        come back empty we log a structured ``voice.fallback_used``
        event so the user (and us in support) can see WHICH leg failed
        without having to enable debug logging mid-incident.
        """
        from pathlib import Path as _Path
        from openagent_core.voice.voice import transcribe as transcribe_local

        text = await self.transcribe_via_gateway(file_path)
        if text:
            return text
        text = await transcribe_local(file_path)
        if text:
            return text
        try:
            size = _Path(file_path).stat().st_size
        except OSError:
            size = -1
        elog(
            "voice.fallback_used",
            level="warning",
            bridge=self.name,
            filename=_Path(file_path).name,
            file_bytes=size,
            hint=(
                "Both the gateway STT endpoint and local faster-whisper "
                "returned empty. Check voice.transcribe.local_* events "
                "above for the cause; common fixes: install voice extras "
                "for faster-whisper, set OPENAGENT_VOICE_LANG=<iso639-1>, "
                "or configure an STT provider row in the DB."
            ),
        )
        return VOICE_FALLBACK


    async def synthesise_voice_reply(self, text: str) -> bytes | None:
        """POST text to ``/api/tts/synthesize`` and return the audio bytes."""
        import aiohttp

        session = await self._audio_session()
        if session is None:
            return None
        url = f"{self._http_base()}/api/tts/synthesize"
        try:
            async with session.post(
                url, json={"text": text},
                headers=self._auth_headers("application/json"),
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status != 200:
                    return None
                return await resp.read()
        except Exception as e:  # noqa: BLE001
            logger.debug("%s.tts.http_exc: %s", self.name, e)
            return None


    async def synthesise_audio_attachment(self, text: str) -> str | None:
        """Synthesize ``text`` to MP3 on disk and return ``[VOICE:/path]``.

        We send the LiteLLM-default MP3 directly — every bridge (Telegram
        ``sendAudio`` / ``sendVoice``, Discord ``File``, WhatsApp
        ``sendFileByUpload``) accepts it. Skipping the OGG/Opus
        transcode keeps the installer free of ffmpeg (~30 MB) and
        removes a native binary from the dependency list.

        Trade-off: Telegram renders MP3 via ``sendVoice`` as a generic
        audio file when the bytes aren't OGG/Opus, so the message
        appears in the music-player UI rather than the native voice-note
        bubble. Acceptable for v1; switch to OGG-Opus output via
        LiteLLM's ``response_format='opus'`` and a tiny pure-Python OGG
        muxer if the voice-note UI matters later.

        ``NamedTemporaryFile(delete=False)`` is used so the bridge can
        finish uploading the file to the platform before deletion —
        the platform sender unlinks it via ``parse_response_markers``-
        driven cleanup once the message lands. (Earlier code used
        ``mkdtemp`` per call with no cleanup, leaking one directory per
        voice reply.)
        """
        import tempfile
        audio = await self.synthesise_voice_reply(text)
        if not audio:
            return None
        with tempfile.NamedTemporaryFile(
            prefix=f"oa_{self.name}_tts_", suffix=".mp3", delete=False,
        ) as fh:
            fh.write(audio)
            mp3_path = fh.name
        return f"[VOICE:{mp3_path}]"


    async def _legacy_command_full(
        self, name: str, session_id: str | None = None, arg: str | None = None,
    ) -> dict:
        """Send a command and wait for the full ``command_result`` dict.

        Same wire round-trip as :meth:`send_command` but returns the whole
        result frame — including an optional ``picker`` (see the protocol
        docstring) that bridges with a button/select primitive render as an
        interactive model chooser. Callers that only need the text should
        use :meth:`send_command`.

        ``session_id`` is forwarded to the gateway so scope-sensitive
        commands (``stop``, ``clear``, ``new``, ``reset``, ``compact``,
        ``model``) can be limited to the specific bridge user who issued
        them. Bridges that multiplex many users onto a single ``client_id``
        (telegram, discord) MUST pass the user's session_id here; otherwise
        a ``/clear`` from one user wipes everyone else's conversation.

        ``arg`` is an optional positional argument forwarded verbatim to the
        gateway (e.g. the runtime_id for ``/model <id>``).
        """
        async with self._command_lock:
            future: asyncio.Future = asyncio.get_running_loop().create_future()
            self._command_future = future
            payload: dict = {"type": P.COMMAND, "name": name}
            if session_id is not None:
                payload["session_id"] = session_id
            if arg is not None:
                payload["arg"] = arg
            try:
                await self._send_gateway_json(payload)
            except Exception:
                if self._command_future is future:
                    self._command_future = None
                raise
            try:
                result = await future
            finally:
                if self._command_future is future:
                    self._command_future = None
            return result if isinstance(result, dict) else {"text": str(result)}


    async def _legacy_command(
        self, name: str, session_id: str | None = None, arg: str | None = None,
    ) -> str:
        """Send a command and wait for the result text.

        Thin wrapper over :meth:`send_command_full` for callers that don't
        render a picker (the common case: destructive-command confirms,
        ``/model <id>`` switches, ``/help``, etc.).
        """
        result = await self._legacy_command_full(name, session_id=session_id, arg=arg)
        return result.get("text", "")
