"""Independent host attestation reuses real provider membership verification."""
import asyncio
from dataclasses import asdict, replace
from types import SimpleNamespace
import time

import pytest

from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import BridgeContext
from openagent_channel_bridges.slack import SlackBridge
from openagent_channel_bridges.stdio import StdioBridgeTransport, describe
from openagent_channel_bridges.wire import PROTOCOL, WireError, context_dto, decode_line


class Admission:
    async def authorize_context(self, context):
        return True

    async def authorize_delivery(self, context):
        raise AssertionError("attestation must not recursively authorize delivery")


class SlackClient:
    def __init__(self):
        self.members = ["UALICE", "UBOB", "UBOT"]
        self.complete = True
        self.reads = 0

    async def auth_test(self):
        return {"ok": True, "team_id": "TONE", "user_id": "UBOT"}

    async def conversations_members(self, **kwargs):
        assert kwargs["channel"] == "CONE"
        self.reads += 1
        return {"ok": True, "members": self.members,
                "has_more": not self.complete, "response_metadata": {"next_cursor": ""}}


def fixture(transport=None):
    bridge = SlackBridge(transport=transport or Admission(), binding_id="binding",
                         bot_token="synthetic", allowed_users=["UALICE"], listen_channels=["CONE"])
    client = SlackClient()
    bridge._account_id = "TONE"
    bridge._bot_user_id = "UBOT"
    bridge._app = SimpleNamespace(client=client)
    context = BridgeContext("binding", "slack", "TONE", "UALICE", "CONE", "event",
                            conversation_kind="channel")
    return bridge, client, context


@pytest.mark.asyncio
async def test_slack_attestation_refreshes_membership_and_denies_removed_actor():
    bridge, client, context = fixture()
    original = await bridge.attest_context(context)
    assert original.audience_ids == ("UALICE", "UBOB")
    assert original.audience_complete is True
    assert 0 <= time.time() - original.audience_verified_at < 5
    client.members = ["UALICE", "UNEW", "UBOT"]
    fresh = await bridge.attest_context(original)
    assert fresh.audience_ids == ("UALICE", "UNEW")
    assert fresh.conversation.audience_epoch != original.conversation.audience_epoch
    client.members = ["UBOB", "UBOT"]
    with pytest.raises(PermissionError):
        await bridge.attest_context(original)
    assert client.reads == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["account", "incomplete", "binding"])
async def test_slack_attestation_cannot_reuse_claimed_audience_on_failure(change):
    bridge, client, context = fixture()
    claimed = replace(context, audience_ids=("UALICE", "UBOB"), audience_complete=True,
                      audience_verified_at=time.time())
    if change == "account":
        claimed = replace(claimed, account_id="TOTHER")
    elif change == "binding":
        claimed = replace(claimed, binding_id="another")
    else:
        client.complete = False
    with pytest.raises(PermissionError):
        await bridge.attest_context(claimed)


@pytest.mark.asyncio
async def test_base_provider_without_refresh_cannot_echo_supplied_attestation():
    bridge = BaseBridge(transport=Admission(), binding_id="binding")
    context = BridgeContext("binding", "slack", "TONE", "UALICE", "CONE", "event",
        conversation_kind="channel", audience_ids=("UALICE",), audience_complete=True,
        audience_verified_at=time.time())
    with pytest.raises(PermissionError):
        await bridge.attest_context(context)


@pytest.mark.asyncio
async def test_root_stdio_request_keeps_reader_free_for_nested_admission():
    queue = asyncio.Queue()
    async def write(line):
        await queue.put(decode_line(line))
    transport = StdioBridgeTransport(write, binding_id="binding", provider="slack")
    bridge, client, context = fixture(transport)
    transport.attest_context = bridge.attest_context
    request = {"protocol": PROTOCOL, "type": "request", "request_id": "host-attest",
               "method": "attest_context", "params": {"context": asdict(context)}}
    try:
        await asyncio.wait_for(transport.receive(request), 1)
        while True:
            frame = await asyncio.wait_for(queue.get(), 1)
            if frame["request_id"] == "host-attest":
                assert frame["type"] == "result"
                fresh = context_dto(frame["result"])
                assert fresh.audience_ids == ("UALICE", "UBOB")
                assert client.reads == 1
                break
            assert frame["method"] == "authorize_context"
            await transport.receive({"protocol": PROTOCOL, "type": "result",
                                     "request_id": frame["request_id"], "result": True})
        assert describe()["context_attestation"] is True
        assert describe()["host_methods"] == ["attest_context", "outbound_open", "deliver"]
        # Independent attestation accepts no artifact parent or untrusted fields.
        with pytest.raises(WireError):
            await transport.receive({**request, "parent_request_id": "child-1"})
        invalid = {**request, "request_id": "bad-context", "params": {"context": {**asdict(context), "authority": "owner"}}}
        await transport.receive(invalid)
        denied = await asyncio.wait_for(queue.get(), 1)
        assert denied["error"] == {"code": "context_rejected"}
        assert client.reads == 1
    finally:
        pending = tuple(transport._host_requests.values())
        transport.close()
        await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_independent_attestation_is_cancelled_on_transport_eof():
    queue = asyncio.Queue()
    started, cancelled = asyncio.Event(), asyncio.Event()
    async def write(line):
        await queue.put(decode_line(line))
    async def attest(context):
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()
    transport = StdioBridgeTransport(write, binding_id="binding", provider="slack")
    transport.attest_context = attest
    _, _, context = fixture()
    await transport.receive({"protocol": PROTOCOL, "type": "request", "request_id": "closing",
        "method": "attest_context", "params": {"context": asdict(context)}})
    await asyncio.wait_for(started.wait(), 1)
    pending = tuple(transport._host_requests.values())
    transport.close()
    await asyncio.gather(*pending, return_exceptions=True)
    assert cancelled.is_set()
    assert queue.empty()
