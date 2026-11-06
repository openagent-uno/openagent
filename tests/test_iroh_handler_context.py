"""Inbound Iroh handlers run in the context they were registered from.

iroh delivers ``ProtocolHandler.accept`` from its own scheduling, outside the
registering code's contextvars. Without binding the registration context, the
agent directory is unset inside every inbound connection, so ``elog`` silently
drops the auth middleware's events (``agent.contact``, ``peer.denied``,
``auth.fail``) instead of writing them to events.jsonl.
"""
import asyncio
import contextvars

from openagent_identity.iroh_node import _IrohEventLoop, _PythonProtocolCreator

marker: contextvars.ContextVar[str | None] = contextvars.ContextVar("marker", default=None)


async def test_foreign_future_cleanup_wakes_the_owner_debug_loop():
    loop = asyncio.get_running_loop()
    previous_debug = loop.get_debug()
    loop.set_debug(True)
    delivered = asyncio.Event()
    owner = _IrohEventLoop(loop)
    try:
        assert owner.create_future().get_loop() is loop
        await asyncio.to_thread(owner.call_soon, delivered.set)
        await asyncio.wait_for(delivered.wait(), 1)
    finally:
        loop.set_debug(previous_debug)


async def test_accept_runs_the_handler_in_the_registration_context():
    seen = []

    async def handler(connection):
        seen.append((connection, marker.get()))
        marker.set("changed by the handler")

    token = marker.set("registered")
    registration = contextvars.copy_context()
    marker.reset(token)

    protocol = _PythonProtocolCreator("test", handler, registration).create(endpoint=None)
    # Deliver the connection the way iroh does: from a context that knows
    # nothing of the registering code.
    delivered = contextvars.Context().run(asyncio.ensure_future, protocol.accept("conn-1"))
    await delivered
    await asyncio.gather(*protocol._tasks)
    second = contextvars.Context().run(asyncio.ensure_future, protocol.accept("conn-2"))
    await second
    await asyncio.gather(*protocol._tasks)

    # Each connection sees the registration context, and one connection's
    # writes never leak into the next (each runs in its own copy).
    assert seen == [("conn-1", "registered"), ("conn-2", "registered")]
    assert registration.run(marker.get) == "registered"
