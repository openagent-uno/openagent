"""Adapter from Iroh ``RecvStream``/``SendStream`` to asyncio ``StreamReader``/``StreamWriter``.

aiohttp's HTTP parser, the WebSocket framing code, and basically every
asyncio-native protocol implementation expect ``StreamReader``-shaped
APIs. Iroh exposes a different surface: ``await recv.read(n)`` /
``await send.write(data)``. This module bridges the two.

Design choices:

  - ``IrohStreamReader`` is a real asyncio ``StreamReader`` whose buffer
    is fed by a small pump task that reads off the Iroh stream until
    EOF. We don't subclass — we hand callers a vanilla StreamReader so
    aiohttp's internal type checks are happy.
  - ``IrohStreamWriter`` quacks like asyncio's writer but only
    implements the methods aiohttp actually calls (``write``,
    ``writelines``, ``drain``, ``close``, ``can_write_eof``,
    ``write_eof``, ``is_closing``, ``transport``, ``get_extra_info``).
    Faking the full ``StreamWriter`` API would require a real
    Transport, which Iroh streams don't have.

There's no try-everything fallback: if Iroh's stream API has changed
(say in a 0.36 bump), the `_pump` loop will fail loudly and we can
adjust here in one place.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


READ_CHUNK = 64 * 1024  # large enough to keep up with WS frames; small enough for prompt cancellation

# A native write can accept a prefix when QUIC has limited send credit.
# Bound each wait for progress, including during close, independently of the
# total time the response body takes to reach a slow reader.
_WRITE_IDLE_TIMEOUT_S = 120.0
_WRITE_CHUNK = 64 * 1024
_DEFAULT_WRITE_HIGH_WATER = 64 * 1024


class _FakeTransport:
    """Minimal asyncio.Transport surface that aiohttp pokes at."""

    def __init__(self, peer_node_id: str, alpn: bytes) -> None:
        self._closing = False
        self._peer_node_id = peer_node_id
        self._alpn = alpn
        # aiohttp queries ``get_extra_info('peername')`` for logging;
        # returning a tuple shaped like a TCP peername keeps its access.log
        # formatter happy without a special case.
        self._peer_name = (peer_node_id, 0)

    def get_extra_info(self, name: str, default: Any = None) -> Any:
        if name == "peername":
            return self._peer_name
        if name == "sockname":
            return ("iroh", 0)
        if name == "openagent_peer_node_id":
            return self._peer_node_id
        if name == "openagent_alpn":
            return self._alpn
        return default

    def is_closing(self) -> bool:
        return self._closing

    def close(self) -> None:
        self._closing = True


class IrohStreamReader:
    """Factory only — callers receive a real ``asyncio.StreamReader``."""

    def __new__(cls, recv_stream: object, *, loop: asyncio.AbstractEventLoop | None = None) -> asyncio.StreamReader:
        loop = loop or asyncio.get_event_loop()
        # Picking a generous limit: the gateway streams audio chunks
        # and image attachments through the WS, and we don't want
        # aiohttp's parser to choke on a single large frame. 4 MiB
        # matches aiohttp's default ``read_buffer_size``.
        reader = asyncio.StreamReader(limit=4 * 1024 * 1024, loop=loop)
        loop.create_task(_pump_recv_into(reader, recv_stream), name="iroh-recv-pump")
        return reader  # type: ignore[return-value]


async def _pump_recv_into(reader: asyncio.StreamReader, recv_stream: object) -> None:
    """Drain *recv_stream* and feed bytes into *reader* until EOF."""
    try:
        while True:
            try:
                chunk = await recv_stream.read(READ_CHUNK)
            except Exception as e:  # noqa: BLE001
                logger.debug("iroh recv read failed: %s", e)
                reader.feed_eof()
                return
            if not chunk:
                reader.feed_eof()
                return
            reader.feed_data(chunk)
    except asyncio.CancelledError:
        reader.feed_eof()
        raise


class IrohStreamWriter:
    """Quacks like ``asyncio.StreamWriter`` for the methods aiohttp uses.

    aiohttp's WebSocket and HTTP/1 paths only need a small subset, so we
    don't bother emulating the full surface. If a future change makes
    aiohttp call something else, add the shim here — there is exactly
    one writer implementation in this codebase.
    """

    def __init__(
        self,
        send_stream: object,
        *,
        peer_node_id: str = "unknown",
        alpn: bytes = b"",
    ) -> None:
        self._send = send_stream
        self._closed = False
        self._write_error: type[OSError] | None = None
        self._write_protocol: asyncio.Protocol | None = None
        self._buffered_bytes = 0
        self._high_water = _DEFAULT_WRITE_HIGH_WATER
        self._low_water = self._high_water // 4
        self._write_paused = False
        self._transport = _FakeTransport(peer_node_id, alpn)
        # Writes within a response stay ordered even when a QUIC send
        # accepts only part of an aiohttp buffer.
        self._write_lock = asyncio.Lock()
        # In-flight ``write()`` tasks. ``drain()`` / the finish path gather
        # these so a closing stream waits for EVERY scheduled write — even
        # ones not yet started — before finishing (otherwise the response
        # body is truncated; see ``drain``).
        self._pending: set[asyncio.Task] = set()
        # Strong reference to the deferred close→finish task so the loop can't
        # GC it mid-flight ("Task was destroyed but it is pending").
        self._finish_task: asyncio.Task | None = None

    @property
    def transport(self) -> _FakeTransport:
        return self._transport

    def get_extra_info(self, name: str, default: Any = None) -> Any:
        return self._transport.get_extra_info(name, default)

    def is_closing(self) -> bool:
        return self._closed or self._transport.is_closing()

    def can_write_eof(self) -> bool:
        # Iroh streams support a clean half-close, but aiohttp only
        # calls ``write_eof`` for HTTP request bodies (not responses).
        # Return True so its keepalive logic doesn't think we're an
        # ancient HTTP/0.9 transport.
        return True

    def bind_write_protocol(self, protocol: asyncio.Protocol) -> None:
        self._write_protocol = protocol
        self._update_write_pressure()

    def get_write_buffer_size(self) -> int:
        return self._buffered_bytes

    def get_write_buffer_limits(self) -> tuple[int, int]:
        return self._low_water, self._high_water

    def set_write_buffer_limits(self, high: int | None = None, low: int | None = None) -> None:
        if high is None:
            high = _DEFAULT_WRITE_HIGH_WATER if low is None else 4 * low
        if low is None:
            low = high // 4
        if not 0 <= low <= high:
            raise ValueError("Write buffer limits require 0 <= low <= high")
        self._low_water, self._high_water = low, high
        self._update_write_pressure()

    def _update_write_pressure(self) -> None:
        protocol = self._write_protocol
        if protocol is None or self._write_error is not None:
            return
        if not self._write_paused and self._buffered_bytes > self._high_water:
            self._write_paused = True
            protocol.pause_writing()
        elif self._write_paused and self._buffered_bytes <= self._low_water:
            self._write_paused = False
            protocol.resume_writing()

    def _write_done(self, task: asyncio.Task, size: int) -> None:
        self._pending.discard(task)
        # A partial write still retains its original buffer until completion.
        self._buffered_bytes -= size
        self._update_write_pressure()

    def write(self, data: bytes) -> None:
        if self._closed or not data:
            return
        # The send operation is async, but aiohttp's writer expects
        # ``write`` to be sync (queue and drain). Schedule the actual
        # send on the loop and let ``drain()`` await it.
        loop = asyncio.get_event_loop()
        size = len(data)
        self._buffered_bytes += size
        self._update_write_pressure()
        task = loop.create_task(self._write_async(data))
        self._pending.add(task)
        task.add_done_callback(lambda completed: self._write_done(completed, size))

    def writelines(self, data) -> None:
        for d in data:
            self.write(d)

    async def _write_async(self, data: bytes) -> None:
        async with self._write_lock:
            if self._write_error is not None:
                return
            try:
                write = getattr(self._send, "write", None)
                offset = 0
                while offset < len(data):
                    chunk = data[offset:offset + _WRITE_CHUNK]
                    async with asyncio.timeout(_WRITE_IDLE_TIMEOUT_S):
                        if write is not None:
                            written = await write(chunk)
                        else:
                            # The in-process transport has only write_all().
                            await self._send.write_all(chunk)
                            written = len(chunk)
                    if type(written) is not int or not 0 < written <= len(chunk):
                        raise ConnectionError("Iroh send returned invalid write progress")
                    offset += written
            except Exception as error:
                self.abort(error)

    def abort(self, error: Exception) -> None:
        if self._write_error is not None or (self._finish_task is not None and self._finish_task.done()):
            return
        # Saving the original traceback would retain the failed write buffer.
        self._write_error = TimeoutError if isinstance(error, TimeoutError) else ConnectionError
        current = asyncio.current_task()
        for task in self._pending:
            if task is not current:
                task.cancel()
        self.close()
        if self._write_protocol is not None:
            # A paused aiohttp producer must wake with a connection error.
            asyncio.get_running_loop().call_soon(
                self._write_protocol.connection_lost, self._write_error("Iroh send aborted"),
            )

    def _raise_write_error(self) -> None:
        if self._write_error is not None:
            raise self._write_error("Iroh send aborted")

    async def drain(self) -> None:
        # An observer cancelling its own drain does not own scheduled writes.
        pending = [asyncio.shield(task) for task in self._pending if not task.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._raise_write_error()

    async def write_eof(self) -> None:
        self.close()
        await self.wait_closed()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._transport.close()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._finish_task = loop.create_task(self._drain_then_finish(), name="iroh-send-finish")

    async def close_and_wait(self) -> None:
        self.close()
        try:
            await self.wait_closed()
        except asyncio.CancelledError:
            self.abort(ConnectionAbortedError("Iroh response cancelled during close"))
            await self.wait_closed()
            raise

    async def _drain_then_finish(self) -> None:
        """Publish EOF only after the response body has been accepted."""
        try:
            await self.drain()
            finish = getattr(self._send, "finish", None) or getattr(self._send, "close", None)
            if finish is not None:
                async with asyncio.timeout(_WRITE_IDLE_TIMEOUT_S):
                    await finish()
            self._raise_write_error()
        except Exception as error:
            self.abort(error)
            logger.warning("Iroh send aborted before a clean EOF (%s)", type(error).__name__)
            reset = getattr(self._send, "reset", None)
            if reset is not None:
                try:
                    async with asyncio.timeout(_WRITE_IDLE_TIMEOUT_S):
                        await reset(1)
                except Exception as exc:
                    logger.debug("Iroh send reset failed (%s)", type(exc).__name__)
        finally:
            self._write_protocol = None

    async def wait_closed(self) -> None:
        if self._finish_task is not None:
            await asyncio.shield(self._finish_task)
