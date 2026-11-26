"""Slow and stalled sends through the shared Iroh writer."""
import asyncio
import hashlib

import pytest

from openagent_identity.transport import asyncio_bridge


class LimitedSend:
    def __init__(self, *, credit, delay=0, stall_after=None):
        self.credit = credit
        self.delay = delay
        self.stall_after = stall_after
        self.digest = hashlib.sha256()
        self.bytes_written = 0
        self.finishes = 0
        self.resets = []
        self.terminated = asyncio.Event()

    async def write(self, data):
        if self.stall_after is not None and self.bytes_written >= self.stall_after:
            await asyncio.Event().wait()
        await asyncio.sleep(self.delay)
        size = min(len(data), self.credit)
        self.digest.update(data[:size])
        self.bytes_written += size
        return size

    async def write_all(self, data):
        for offset in range(0, len(data), self.credit):
            await self.write(data[offset:offset + self.credit])

    async def finish(self):
        self.finishes += 1
        self.terminated.set()

    async def reset(self, code):
        self.resets.append(code)
        self.terminated.set()


@pytest.mark.asyncio
@pytest.mark.parametrize(("megabytes", "delay", "credit"), [
    (2, 0.006, 32 * 1024),
    (12, 0.002, 64 * 1024),
])
async def test_large_response_survives_slow_partial_writes(monkeypatch, megabytes, delay, credit):
    idle_limit = 0.15
    # With the previous writer, this was the absolute wait before EOF.
    monkeypatch.setattr(asyncio_bridge, "_FINISH_DRAIN_TIMEOUT_S", idle_limit, raising=False)
    monkeypatch.setattr(asyncio_bridge, "_WRITE_IDLE_TIMEOUT_S", idle_limit, raising=False)
    send = LimitedSend(credit=credit, delay=delay)
    writer = asyncio_bridge.IrohStreamWriter(send)
    header = b"Content-Length prefix\r\n"
    body = bytes(range(256)) * (megabytes * 4096)

    start = asyncio.get_running_loop().time()
    writer.write(header)
    writer.write(body)
    writer.close()
    await asyncio.wait_for(writer.write_eof(), 6)
    await asyncio.wait_for(send.terminated.wait(), 6)

    assert asyncio.get_running_loop().time() - start > idle_limit
    assert send.bytes_written == len(header) + len(body)
    assert send.digest.digest() == hashlib.sha256(header + body).digest()
    assert send.finishes == 1
    assert send.resets == []


@pytest.mark.asyncio
async def test_stalled_writer_resets_without_clean_eof_or_launching_queued_writes(monkeypatch):
    monkeypatch.setattr(asyncio_bridge, "_WRITE_IDLE_TIMEOUT_S", 0.03, raising=False)
    send = LimitedSend(credit=8, stall_after=8)
    writer = asyncio_bridge.IrohStreamWriter(send)
    writer.write(b"a" * 64)
    writer.write(b"must remain unsent")
    writer.close()

    await asyncio.wait_for(writer.wait_closed(), 1)
    assert send.bytes_written == 8
    assert send.finishes == 0
    assert len(send.resets) == 1
    with pytest.raises(TimeoutError):
        await writer.drain()
    assert not writer._pending


@pytest.mark.asyncio
async def test_keep_legacy_write_all_and_single_finish():
    writes = []

    class AllOnly:
        async def write_all(self, data):
            writes.append(data)

        async def finish(self):
            writes.append(b"EOF")

    writer = asyncio_bridge.IrohStreamWriter(AllOnly())
    writer.writelines((b"header", b"body"))
    await writer.drain()
    await asyncio.gather(writer.write_eof(), writer.write_eof())
    assert writes == [b"header", b"body", b"EOF"]


@pytest.mark.asyncio
async def test_cancelled_drain_observer_leaves_the_send_owned_by_the_writer():
    blocked = asyncio.Event()
    release = asyncio.Event()

    class PausedSend(LimitedSend):
        async def write(self, data):
            blocked.set()
            await release.wait()
            return await super().write(data)

    send = PausedSend(credit=64)
    writer = asyncio_bridge.IrohStreamWriter(send)
    writer.write(b"response")
    observer = asyncio.create_task(writer.drain())
    await asyncio.wait_for(blocked.wait(), 1)
    observer.cancel()
    with pytest.raises(asyncio.CancelledError):
        await observer
    release.set()
    await asyncio.wait_for(writer.write_eof(), 1)
    assert send.bytes_written == len(b"response")
    assert send.finishes == 1
    assert send.resets == []
