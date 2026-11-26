"""Real aiohttp request handlers on both Iroh ALPNs with a constrained peer."""
import asyncio
import hashlib

import pytest
from aiohttp import web

from openagent_identity.iroh_node import NetworkAlpn
from openagent_identity.transport import agent_iroh_site, aiohttp_iroh_site, asyncio_bridge


_BLOCK_SIZE = 64 * 1024
_ALPNS = (NetworkAlpn.GATEWAY, NetworkAlpn.AGENT)


class SlowPeer:
    def __init__(self, alpn):
        request = b"GET /file HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n"
        self.request = request if alpn == NetworkAlpn.AGENT else b"\0\0\0\0" + request
        self.release = asyncio.Event()
        self.first_write = asyncio.Event()
        self.terminated = asyncio.Event()
        self.response = bytearray()
        self.resets = []
        self.finishes = 0

    async def read(self, count):
        if not self.request:
            await asyncio.Event().wait()
        data, self.request = self.request[:count], self.request[count:]
        return data

    async def write(self, data):
        self.first_write.set()
        await self.release.wait()
        await asyncio.sleep(0)
        count = min(len(data), 16 * 1024)
        self.response.extend(data[:count])
        return count

    async def finish(self):
        self.finishes += 1
        self.terminated.set()

    async def reset(self, code):
        self.resets.append(code)
        self.terminated.set()


async def serve(monkeypatch, alpn, handle):
    peer = SlowPeer(alpn)
    writers = []
    site_module = aiohttp_iroh_site if alpn == NetworkAlpn.GATEWAY else agent_iroh_site
    site_type = aiohttp_iroh_site.IrohSite if alpn == NetworkAlpn.GATEWAY else agent_iroh_site.AgentSite

    class MeteredWriter(asyncio_bridge.IrohStreamWriter):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.offered = 0
            self.peak = 0
            writers.append(self)

        def write(self, data):
            self.offered += len(data)
            self.peak = max(self.peak, self.offered - len(peer.response))
            return super().write(data)

    monkeypatch.setattr(site_module, "IrohStreamWriter", MeteredWriter)
    app = web.Application()
    app.router.add_get("/file", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = site_type(runner, node=None)
    serving = asyncio.create_task(site._handle_one_stream("fixture", peer, peer))
    return runner, peer, serving, writers


@pytest.mark.asyncio
@pytest.mark.parametrize("alpn", _ALPNS)
@pytest.mark.parametrize("megabytes", [2, 12])
async def test_slow_peer_bounds_streaming_response_queue(monkeypatch, alpn, megabytes, record_property):
    block = b"data" * (_BLOCK_SIZE // 4)
    blocks = megabytes * (1024 * 1024 // len(block))

    async def handle(request):
        response = web.StreamResponse(headers={"Content-Length": str(len(block) * blocks)})
        await response.prepare(request)
        for _ in range(blocks):
            await response.write(block)
        return response

    runner, peer, serving, writers = await serve(monkeypatch, alpn, handle)
    try:
        await asyncio.wait_for(peer.first_write.wait(), 2)
        writer, = writers
        assert writer.peak <= 2 * _BLOCK_SIZE + 4096, f"queued {writer.peak} bytes"
        assert writer.get_write_buffer_size() == writer.offered
        peer.release.set()
        await asyncio.wait_for(peer.terminated.wait(), 5)
        await asyncio.wait_for(serving, 2)
        headers, sep, body = peer.response.partition(b"\r\n\r\n")
        assert headers.startswith(b"HTTP/1.1 200 ") and sep
        assert len(body) == len(block) * blocks
        assert hashlib.sha256(body).digest() == hashlib.sha256(block * blocks).digest()
        assert writer.peak <= 2 * _BLOCK_SIZE + 4096
        record_property("peak_queued_bytes", writer.peak)
        assert writer.get_write_buffer_size() == 0
        assert peer.finishes == 1 and not peer.resets
    finally:
        peer.release.set()
        await asyncio.gather(serving, return_exceptions=True)
        await runner.cleanup()


@pytest.mark.asyncio
@pytest.mark.parametrize("alpn", _ALPNS)
@pytest.mark.parametrize("cancel", [False, True])
async def test_blocked_http_sender_exits_on_stall_or_cancel(monkeypatch, alpn, cancel):
    monkeypatch.setattr(asyncio_bridge, "_WRITE_IDLE_TIMEOUT_S", 5 if cancel else 0.08)
    handler_left = asyncio.Event()

    async def handle(request):
        try:
            response = web.StreamResponse(headers={"Content-Length": str(8 * _BLOCK_SIZE)})
            await response.prepare(request)
            for _ in range(8):
                await response.write(b"a" * _BLOCK_SIZE)
            return response
        finally:
            handler_left.set()

    runner, peer, serving, writers = await serve(monkeypatch, alpn, handle)
    try:
        await asyncio.wait_for(peer.first_write.wait(), 2)
        writer, = writers
        assert writer.peak <= 2 * _BLOCK_SIZE + 4096
        assert not handler_left.is_set()
        if cancel:
            serving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(serving, 2)
        else:
            await asyncio.wait_for(serving, 2)
        await asyncio.wait_for(handler_left.wait(), 2)
        await asyncio.wait_for(peer.terminated.wait(), 2)
        assert len(peer.resets) == 1 and peer.finishes == 0
        assert writer.get_write_buffer_size() == 0
        assert not writer._pending
    finally:
        peer.release.set()
        await asyncio.gather(serving, return_exceptions=True)
        await runner.cleanup()
