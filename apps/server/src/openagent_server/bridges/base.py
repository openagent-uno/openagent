"""Compatibility adapter for standalone channel bridges.

Embedded hosts import openagent_channel_bridges instead. Only this product
module supplies the historical gateway default and legacy WS/private helpers.
"""
from __future__ import annotations
import asyncio
import logging
import os
import tempfile
from pathlib import Path
from openagent_channel_bridges import base as _shared
from openagent_channel_bridges.base import (
    BaseBridge as SharedBaseBridge, PERSONALITY_PRESETS, VOICE_FALLBACK,
    resolve_personality_directive, format_tool_status, format_tool_message,
    _extract_choice_marker, _LiveProgress, elog,
)
from .gateway_transport import GatewayBridgeTransport
from . import gateway_transport as _gateway

logger = logging.getLogger(__name__)
BRIDGE_RETRY_SECONDS = _shared.BRIDGE_RETRY_SECONDS
BRIDGE_GATEWAY_RECONNECT_BASE_SECONDS = _shared.BRIDGE_GATEWAY_RECONNECT_BASE_SECONDS
BRIDGE_GATEWAY_RECONNECT_MAX_SECONDS = _shared.BRIDGE_GATEWAY_RECONNECT_MAX_SECONDS
BRIDGE_GATEWAY_RECONNECT_STABLE_SECONDS = _shared.BRIDGE_GATEWAY_RECONNECT_STABLE_SECONDS
BRIDGE_GATEWAY_LOSS_GRACE_SECONDS = _gateway.BRIDGE_GATEWAY_LOSS_GRACE_SECONDS
BRIDGE_WS_HEARTBEAT_SECONDS = _gateway.BRIDGE_WS_HEARTBEAT_SECONDS
BRIDGE_COALESCE_WINDOW_MS = _shared.BRIDGE_COALESCE_WINDOW_MS
# Historical tests/importers use these names; wire ownership stays standalone.
P = _gateway.P
StreamCollector = _gateway.StreamCollector
fold_outbound_event = _gateway.fold_outbound_event
SessionOpen = _gateway.SessionOpen
TextFinal = _gateway.TextFinal
now_ms = _gateway.now_ms
event_to_wire = _gateway.event_to_wire
wire_to_event = _gateway.wire_to_event
SESSION_COMPACTED = _gateway.SESSION_COMPACTED


def make_gateway_transport(gateway_url="ws://localhost:8765/ws", gateway_token=None, *, name="bridge", binding_id=None):
    transport = GatewayBridgeTransport(gateway_url, gateway_token)
    transport.name = name
    return transport


_GATEWAY_FIELDS = frozenset(("gateway_url", "gateway_token", "_ws", "_ws_session", "_http_session",
    "_listener_task", "_gateway_lost", "_gateway_generation", "_gateway_loss_cleanup_task",
    "_command_future", "_command_lock", "_stream_opened", "_stream_pending", "_learning_conn"))


class BaseBridge(SharedBaseBridge):
    def __init__(self, gateway_url="ws://localhost:8765/ws", gateway_token=None, personality=None, live=None,
                 *, transport=None, binding_id=None, delivery_mode=None, acknowledgement_text=None):
        transport = transport if transport is not None else make_gateway_transport(gateway_url, gateway_token, name=self.name)
        super().__init__(transport=transport, binding_id=binding_id, personality=personality,
                         live=live, delivery_mode=delivery_mode, acknowledgement_text=acknowledgement_text)

    def __getattr__(self, name):
        transport = self.__dict__.get("transport")
        if transport is not None and hasattr(transport, name):
            return getattr(transport, name)
        raise AttributeError(name)

    def __setattr__(self, name, value):
        transport = self.__dict__.get("transport")
        if name in _GATEWAY_FIELDS and isinstance(transport, GatewayBridgeTransport):
            setattr(transport, name, value)
        else:
            object.__setattr__(self, name, value)

    @staticmethod
    def _gateway_reconnect_delay(streak):
        if streak <= 0:
            return 0.0
        base = max(0.0, BRIDGE_GATEWAY_RECONNECT_BASE_SECONDS)
        return min(max(base, BRIDGE_GATEWAY_RECONNECT_MAX_SECONDS), base * (2 ** max(0, streak - 1)))

    async def _authorize_outbound(self):
        if _shared._active_context.get() is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            return  # Historical untyped API only; provider typed callbacks use context.
        await super()._authorize_outbound()

    async def send_message(self, text, session_id=None, *, context=None, history=None, **kwargs):
        if context is None and _shared._active_context.get() is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            kwargs.pop("history", None)
            return await GatewayBridgeTransport._legacy_send_message(self, text, session_id, **kwargs)
        return await super().send_message(text, session_id, context=context, history=history, **kwargs)

    async def send_command_full(self, name, session_id=None, arg=None, *, context=None, confirmed=False):
        if context is None and _shared._active_context.get() is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            return await GatewayBridgeTransport._legacy_command_full(self, name, session_id, arg)
        return await super().send_command_full(name, session_id, arg, context=context, confirmed=confirmed)

    async def dispatch_turn(self, target, session_id, text, *, context=None, history=(), **kwargs):
        if context is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            return await self._dispatch_turn(target, session_id, text, **kwargs)
        return await super().dispatch_turn(target, session_id, text, context=context, history=history, **kwargs)

    async def stop(self):
        await super().stop()
        transport = self.__dict__.get("transport")
        if isinstance(transport, GatewayBridgeTransport):
            await transport.stop()

    async def transcribe_with_fallback(self, file_path, *, context=None):
        if context is None and _shared._active_context.get() is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            return await self.transport.transcribe_with_fallback(file_path)
        return await super().transcribe_with_fallback(file_path, context=context)

    async def transcribe_via_gateway(self, file_path, *, context=None):
        if context is None and _shared._active_context.get() is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            return await self.transport.transcribe_via_gateway(file_path)
        return await super().transcribe_via_gateway(file_path, context=context)

    async def synthesise_voice_reply(self, text, *, context=None):
        if context is None and _shared._active_context.get() is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            return await self.transport.synthesise_voice_reply(text)
        return await super().synthesise_voice_reply(text, context=context)

    async def synthesise_audio_attachment(self, text, *, context=None):
        if context is None and _shared._active_context.get() is None and isinstance(self.__dict__.get("transport"), GatewayBridgeTransport):
            return await self.transport.synthesise_audio_attachment(text)
        return await super().synthesise_audio_attachment(text, context=context)

    # Preserve the raw gateway test/compatibility surface on the product class.
    _resolve_orphaned_futures = GatewayBridgeTransport._resolve_orphaned_futures
    _cancel_gateway_loss_cleanup = GatewayBridgeTransport._cancel_gateway_loss_cleanup
    _schedule_gateway_loss_cleanup = GatewayBridgeTransport._schedule_gateway_loss_cleanup

    @staticmethod
    def _gateway_loss_grace_seconds():
        return BRIDGE_GATEWAY_LOSS_GRACE_SECONDS
    _send_gateway_json = GatewayBridgeTransport._send_gateway_json
    _connect_gateway = GatewayBridgeTransport._connect_gateway
    _listen_gateway = GatewayBridgeTransport._listen_gateway
    _handle_gateway_frame = GatewayBridgeTransport._handle_gateway_frame
    _http_base = GatewayBridgeTransport._http_base
    _audio_session = GatewayBridgeTransport._audio_session
    _auth_headers = GatewayBridgeTransport._auth_headers
    _get_learning_db_shim = GatewayBridgeTransport._get_learning_db_shim

    @staticmethod
    def _cleanup_owned_temp_artifact(path: str | None) -> None:
        """Best-effort unlink of bridge-owned temp files.

        We only remove files we can confidently identify as OpenAgent's
        own ephemeral artifacts: direct children of the OS temp dir whose
        basename starts with ``oa_``. This covers voice replies, stream
        snapshots, uploads, and similar per-turn scratch files while
        avoiding accidental deletion of arbitrary user files the agent may
        have intentionally attached by local path.
        """
        if not path:
            return
        try:
            temp_root = Path(tempfile.gettempdir()).resolve()
            candidate = Path(path).resolve()
        except Exception:
            return
        if candidate.parent != temp_root:
            return
        if not candidate.name.startswith("oa_"):
            return
        try:
            if candidate.is_file() or candidate.is_symlink():
                os.unlink(candidate)
        except FileNotFoundError:
            return
        except OSError as e:
            logger.debug("bridge temp cleanup skipped for %s: %s", candidate, e)
