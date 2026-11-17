"""Measure real coordinator client RPC framing without networking or an Iroh node.

Run with the server environment from the repository root:
  PYTHONPATH=packages/identity/src apps/server/.venv/bin/python tests/test_coordinator_rpc_performance.py -v

The fake transport charges controlled dial/RPC latency and caps simultaneous
dials. The production device_is_active/_rpc functions still encode, send, read,
and decode every CBOR request. This records the baseline without asserting a
future speedup or a specific pooling implementation. No auth result is cached.
"""
from __future__ import annotations

import asyncio
import json
import os
from statistics import median
from time import perf_counter
import unittest

import cbor2

from openagent_identity.client.login import LoginError, _rpc, device_is_active
from openagent_identity.identity import Identity
from openagent_identity.iroh_node import IrohNode, NetworkAlpn


class _FakeReader:
    def __init__(self, connection, response, *, fail=False):
        self.connection = connection
        self.response = response
        self.fail = fail
        self.offset = 0

    async def read(self, maximum):
        if self.fail:
            self.fail = False
            raise OSError("controlled stream failure")
        if not self.response.done():
            closed = asyncio.create_task(self.connection.closed_event.wait())
            try:
                await asyncio.wait((self.response, closed), return_when=asyncio.FIRST_COMPLETED)
            finally:
                closed.cancel()
                await asyncio.gather(closed, return_exceptions=True)
        if self.connection.closed:
            raise OSError("connection is closed")
        wire = self.response.result()
        # Exercise the real client's read-exact loop, including short reads.
        size = min(maximum, 7)
        chunk = wire[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk


class _FakeWriter:
    def __init__(self, connection, response):
        self.connection = connection
        self.response = response
        self.wire = bytearray()

    async def write_all(self, data):
        if self.connection.closed:
            raise OSError("connection is closed")
        if self.connection.node.fail_next_write:
            self.connection.node.fail_next_write = False
            raise OSError("controlled write failure")
        self.wire.extend(data)

    async def finish(self):
        size = int.from_bytes(self.wire[:4], "big")
        if len(self.wire) != size + 4:
            raise AssertionError("invalid production request framing")
        request = cbor2.loads(self.wire[4:])
        node = self.connection.node
        node.requests.append({
            "coordinator": self.connection.coordinator,
            "request": request,
        })

        async def respond():
            await asyncio.sleep(node.rpc_delay)
            node.live_checks += 1
            key = (self.connection.coordinator, request["params"]["device_pubkey"])
            value = {"id": request["id"], "result": {"active": key not in node.revoked}}
            if node.rpc_error:
                value = {"id": request["id"], "error": node.rpc_error}
            payload = cbor2.dumps(value)
            if not self.response.done():
                self.response.set_result(len(payload).to_bytes(4, "big") + payload)

        task = asyncio.create_task(respond())
        node.tasks.add(task)
        task.add_done_callback(node.tasks.discard)


class _FakeBiStream:
    def __init__(self, connection, *, fail=False):
        response = asyncio.get_running_loop().create_future()
        self.writer = _FakeWriter(connection, response)
        self.reader = _FakeReader(connection, response, fail=fail)

    def send(self):
        return self.writer

    def recv(self):
        return self.reader


class _FakeConnection:
    def __init__(self, node, coordinator):
        self.node = node
        self.coordinator = coordinator
        self.closed = False
        self.closed_event = asyncio.Event()

    async def open_bi(self):
        if self.closed:
            raise OSError("connection is closed")
        if self.node.fail_next_open:
            self.node.fail_next_open = False
            raise OSError("controlled open failure")
        self.node.streams += 1
        fail = self.node.fail_next_read
        self.node.fail_next_read = False
        return _FakeBiStream(self, fail=fail)

    def close(self, _code, _reason):
        if not self.closed:
            self.node.closes += 1
            self.closed = True
            self.closed_event.set()


class _FakeNode(IrohNode):
    def __init__(self, *, dial_delay=0, rpc_delay=0, dial_concurrency=2):
        super().__init__(Identity.from_secret_bytes(b"n" * 32))
        self.dial_delay = dial_delay
        self.rpc_delay = rpc_delay
        self.dial_slots = asyncio.Semaphore(dial_concurrency)
        self.dials = 0
        self.streams = 0
        self.closes = 0
        self.live_checks = 0
        self.active_dials = 0
        self.max_active_dials = 0
        self.fail_next_read = False
        self.fail_next_write = False
        self.fail_next_open = False
        self.fail_next_dial = False
        self.dial_gate = None
        self.ignore_dial_cancellation = False
        self.rpc_error = None
        self.connections = []
        self.requests = []
        self.tasks = set()
        self.revoked = set()

    async def dial(self, coordinator, alpn, *, relay_url=None, addresses=None):
        if alpn != NetworkAlpn.COORDINATOR:
            raise AssertionError("unexpected ALPN")
        self.dials += 1
        async with self.dial_slots:
            self.active_dials += 1
            self.max_active_dials = max(self.max_active_dials, self.active_dials)
            try:
                if self.fail_next_dial:
                    self.fail_next_dial = False
                    raise OSError("controlled dial failure")
                if self.dial_gate is not None:
                    try:
                        await self.dial_gate.wait()
                    except asyncio.CancelledError:
                        if not self.ignore_dial_cancellation:
                            raise
                        await self.dial_gate.wait()
                await asyncio.sleep(self.dial_delay)
            finally:
                self.active_dials -= 1
        connection = _FakeConnection(self, coordinator)
        self.connections.append(connection)
        return connection

    async def stop(self):
        # Exercise production pool shutdown without creating a native node.
        await super().stop()
        if self.tasks:
            await asyncio.gather(*tuple(self.tasks))


async def _until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0)


class CoordinatorRpcPerformanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_record_sequential_and_concurrent_status_baselines(self):
        count = 8
        scenarios = []
        for mode in ("sequential", "concurrent"):
            node = _FakeNode(dial_delay=0.04, rpc_delay=0.01, dial_concurrency=2)
            durations = []

            async def check(index):
                started = perf_counter()
                result = await device_is_active(
                    node=node, coordinator_node_id="coordinator-a",
                    device_pubkey=bytes([index]) * 32,
                )
                durations.append((perf_counter() - started) * 1000)
                return result

            try:
                started = perf_counter()
                if mode == "sequential":
                    results = [await check(index) for index in range(count)]
                else:
                    results = await asyncio.gather(*(check(index) for index in range(count)))
                wall_ms = (perf_counter() - started) * 1000
                self.assertEqual(results, [True] * count)
                self.assertEqual(node.live_checks, count)
                self.assertEqual(len(node.requests), count)
                self.assertEqual(len({row["request"]["id"] for row in node.requests}), count)
                scenarios.append({
                    "mode": mode, "status_requests": count,
                    "dial_delay_ms": 40, "rpc_delay_ms": 10,
                    "dial_concurrency_limit": 2,
                    "wall_ms": round(wall_ms, 2),
                    "median_request_ms": round(median(durations), 2),
                    "request_ms": [round(value, 2) for value in durations],
                    "dials": node.dials, "streams": node.streams,
                    "live_checks": node.live_checks,
                    "closes_before_harness_cleanup": node.closes,
                    "max_active_dials": node.max_active_dials,
                })
            finally:
                await node.stop()
        print("OPENAGENT_COORDINATOR_RPC_PERFORMANCE " + json.dumps({
            "benchmark": "real-client-device-status-over-fake-transport",
            "label": os.environ.get("OPENAGENT_PERF_LABEL", "unlabelled"),
            "scenarios": scenarios,
        }, sort_keys=True), flush=True)

    async def test_each_request_observes_current_revocation(self):
        node = _FakeNode()
        device = b"a" * 32
        try:
            self.assertTrue(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=device))
            node.revoked.add(("a", device))
            self.assertFalse(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=device))
            node.revoked.remove(("a", device))
            self.assertTrue(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=device))
            self.assertEqual(node.live_checks, 3)
        finally:
            await node.stop()

    async def test_node_coordinator_and_device_boundaries_stay_independent(self):
        first, second = _FakeNode(), _FakeNode()
        device, other_device = b"a" * 32, b"b" * 32
        first.revoked.add(("b", device))
        second.revoked.add(("a", device))
        try:
            results = await asyncio.gather(
                device_is_active(node=first, coordinator_node_id="a", device_pubkey=device),
                device_is_active(node=first, coordinator_node_id="b", device_pubkey=device),
                device_is_active(node=second, coordinator_node_id="a", device_pubkey=device),
                device_is_active(node=first, coordinator_node_id="a", device_pubkey=other_device),
            )
            self.assertEqual(results, [True, False, False, True])
            self.assertEqual(first.live_checks, 3)
            self.assertEqual(second.live_checks, 1)
            for row in first.requests + second.requests:
                self.assertEqual(row["request"]["method"], "device_status")
                self.assertEqual(len(row["request"]["params"]["device_pubkey"]), 32)
        finally:
            await first.stop()
            await second.stop()

    async def test_failed_stream_does_not_poison_the_next_live_check(self):
        node = _FakeNode()
        node.fail_next_read = True
        try:
            with self.assertRaises(OSError):
                await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32)
            self.assertTrue(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
        finally:
            await node.stop()

    async def test_concurrent_calls_share_a_dial_but_never_a_status_result(self):
        node = _FakeNode(dial_delay=0.01, rpc_delay=0.01)
        try:
            results = await asyncio.gather(*(device_is_active(
                node=node, coordinator_node_id="a", device_pubkey=bytes([index]) * 32,
            ) for index in range(12)))
            self.assertEqual(results, [True] * 12)
            self.assertEqual((node.dials, node.streams, node.live_checks), (1, 12, 12))
            self.assertEqual(node.closes, 0)
        finally:
            await node.stop()
        self.assertEqual(node.closes, 1)

    async def test_stream_failure_retires_without_interrupting_other_live_streams(self):
        node = _FakeNode(rpc_delay=0.04)
        healthy = None
        try:
            healthy = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
            await _until(lambda: len(node.requests) == 1)
            original = node.connections[0]
            node.fail_next_read = True
            with self.assertRaises(OSError):
                await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"b" * 32)
            self.assertFalse(original.closed)
            replacement = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"c" * 32))
            self.assertTrue(await healthy)
            self.assertTrue(await replacement)
            self.assertTrue(original.closed)
            self.assertEqual(node.dials, 2)
        finally:
            await node.stop()
            if healthy is not None:
                await asyncio.gather(healthy, return_exceptions=True)

    async def test_cancelled_dial_waiter_does_not_cancel_another_waiter(self):
        node = _FakeNode()
        node.dial_gate = asyncio.Event()
        first = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
        second = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"b" * 32))
        try:
            await _until(lambda: node.dials == 1)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            node.dial_gate.set()
            self.assertTrue(await second)
            self.assertEqual((node.dials, node.live_checks), (1, 1))
        finally:
            node.dial_gate.set()
            await node.stop()
            await asyncio.gather(first, second, return_exceptions=True)

    async def test_timeout_covers_dial_and_response_and_allows_recovery(self):
        for stage in ("dial", "response"):
            with self.subTest(stage=stage):
                node = _FakeNode(dial_delay=0.04 if stage == "dial" else 0,
                                 rpc_delay=0.04 if stage == "response" else 0)
                try:
                    with self.assertRaises(TimeoutError):
                        await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32, timeout=0.005)
                    node.dial_delay = node.rpc_delay = 0
                    self.assertTrue(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
                    self.assertEqual(node.dials, 2)
                finally:
                    await node.stop()

    async def test_dial_open_and_write_failures_are_evicted_for_next_call(self):
        for stage in ("dial", "open", "write"):
            with self.subTest(stage=stage):
                node = _FakeNode()
                setattr(node, "fail_next_" + stage, True)
                try:
                    with self.assertRaises(OSError):
                        await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32)
                    self.assertTrue(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
                    self.assertEqual(node.dials, 2)
                finally:
                    await node.stop()

    async def test_mutating_rpc_is_not_replayed_after_a_sent_request_fails(self):
        node = _FakeNode()
        node.fail_next_read = True
        try:
            with self.assertRaises(OSError):
                await _rpc(node=node, coordinator_node_id="a", method="login_finish", params={"device_pubkey": b"a" * 32})
            self.assertEqual(len(node.requests), 1)
            self.assertEqual(node.dials, 1)
        finally:
            await node.stop()

    async def test_application_denial_does_not_replay_or_invalidate_transport(self):
        node = _FakeNode()
        node.rpc_error = {"code": "forbidden", "message": "controlled denial"}
        try:
            with self.assertRaisesRegex(LoginError, "forbidden"):
                await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32)
            node.rpc_error = None
            self.assertTrue(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
            self.assertEqual((node.dials, node.live_checks), (1, 2))
        finally:
            await node.stop()

    async def test_stop_closes_idle_pool_once_and_rejects_new_calls(self):
        node = _FakeNode()
        self.assertTrue(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
        await node.stop()
        await node.stop()
        self.assertEqual(node.closes, 1)
        with self.assertRaisesRegex(LoginError, "stopped"):
            await device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32)
        self.assertEqual(node.dials, 1)

    async def test_stop_closes_a_late_dial_and_fails_its_waiter_closed(self):
        node = _FakeNode()
        node.dial_gate = asyncio.Event()
        node.ignore_dial_cancellation = True
        request = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
        try:
            await _until(lambda: node.dials == 1)
            await node.stop()
            node.dial_gate.set()
            with self.assertRaises(LoginError):
                await request
            self.assertEqual(node.closes, 1)
            self.assertEqual(node.live_checks, 0)
        finally:
            node.dial_gate.set()
            await node.stop()
            await asyncio.gather(request, return_exceptions=True)

    async def test_cancellation_retires_only_after_another_active_stream_finishes(self):
        node = _FakeNode(rpc_delay=0.04)
        first = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
        second = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"b" * 32))
        try:
            await _until(lambda: len(node.requests) == 2)
            connection = node.connections[0]
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            self.assertFalse(connection.closed)
            self.assertTrue(await second)
            self.assertTrue(connection.closed)
            self.assertEqual(node.dials, 1)
        finally:
            await node.stop()
            await asyncio.gather(first, second, return_exceptions=True)

    async def test_revocation_during_an_inflight_check_is_returned_fresh(self):
        node = _FakeNode(rpc_delay=0.02)
        device = b"a" * 32
        request = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=device))
        try:
            await _until(lambda: len(node.requests) == 1)
            node.revoked.add(("a", device))
            self.assertFalse(await request)
            self.assertFalse(await device_is_active(node=node, coordinator_node_id="a", device_pubkey=device))
            self.assertEqual((node.dials, node.live_checks), (1, 2))
        finally:
            await node.stop()
            await asyncio.gather(request, return_exceptions=True)

    async def test_stop_fails_an_active_rpc_closed(self):
        node = _FakeNode(rpc_delay=0.02)
        request = asyncio.create_task(device_is_active(node=node, coordinator_node_id="a", device_pubkey=b"a" * 32))
        try:
            await _until(lambda: len(node.requests) == 1)
            await node.stop()
            with self.assertRaises(OSError):
                await request
            self.assertEqual(node.closes, 1)
        finally:
            await node.stop()
            await asyncio.gather(request, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
