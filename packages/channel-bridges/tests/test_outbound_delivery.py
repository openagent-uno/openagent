"""Host-initiated delivery: an admitted binding posts as its own bot."""
import asyncio
import base64
import hashlib
from types import SimpleNamespace

import pytest

from openagent_channel_bridges.slack import SlackBridge
from openagent_channel_bridges.stdio import StdioBridgeTransport, describe
from openagent_channel_bridges.wire import PROTOCOL, decode_line


class Host:
    def __init__(self, deliver=True):
        self.deliver = deliver
        self.contexts = []

    async def authorize_context(self, context):
        self.contexts.append(context)
        return True

    async def authorize_delivery(self, context):
        self.contexts.append(context)
        return self.deliver


class SlackClient:
    def __init__(self, *, member=True, members=("UALICE", "UBOT")):
        self.member, self.members, self.posted = member, list(members), []

    async def auth_test(self):
        return {"ok": True, "team_id": "TONE", "user_id": "UBOT"}

    async def conversations_info(self, channel):
        return {"ok": True, "channel": {"id": channel, "is_member": self.member, "is_im": channel.startswith("D")}}

    async def conversations_members(self, **kwargs):
        return {"ok": True, "members": self.members, "has_more": False, "response_metadata": {"next_cursor": ""}}

    async def chat_postMessage(self, **kwargs):
        self.posted.append(kwargs)
        return {"ok": True}


def bridge(host=None, client=None, listen=("CONE",)):
    value = SlackBridge(transport=host or Host(), binding_id="binding", bot_token="synthetic",
                        allowed_users=["UALICE"], listen_channels=list(listen))
    value._account_id, value._bot_user_id = "TONE", "UBOT"
    value._app = SimpleNamespace(client=client or SlackClient())
    return value


@pytest.mark.asyncio
async def test_slack_posts_text_as_its_bot_after_audience_and_host_authorization():
    host, client = Host(), SlackClient()
    slack = bridge(host, client)
    await slack.deliver_outbound(delivery_id="d1", conversation_id="CONE", text="Weekly report ready")
    assert client.posted == [{"channel": "CONE", "text": "Weekly report ready"}]
    delivered = [context for context in host.contexts if context.audience_complete]
    assert delivered and delivered[-1].actor_id == "UBOT" and delivered[-1].audience_ids == ("UALICE",)
    assert all(context.event_id == "outbound-d1" for context in host.contexts)
    assert not slack._outbound_events, "the outbound marker never outlives its delivery"


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["direct", "unlisted", "not-member", "host-denied", "empty"])
async def test_slack_outbound_delivery_fails_closed(case):
    client = SlackClient(member=case != "not-member")
    slack = bridge(Host(deliver=case != "host-denied"), client)
    conversation = {"direct": "DONE", "unlisted": "COTHER"}.get(case, "CONE")
    error = ValueError if case == "empty" else PermissionError
    with pytest.raises(error):
        await slack.deliver_outbound(delivery_id="d2", conversation_id=conversation,
                                     text="" if case == "empty" else "hello")
    assert client.posted == []


@pytest.mark.asyncio
async def test_inbound_contexts_keep_rejecting_the_bot_actor():
    from openagent_channel_bridges.contracts import BridgeContext
    slack = bridge()
    context = BridgeContext("binding", "slack", "TONE", "UBOT", "CONE", "outbound-forged", conversation_kind="channel")
    with pytest.raises(PermissionError):
        await slack._delivery_context(context)


@pytest.mark.asyncio
async def test_stdio_outbound_scope_uploads_files_then_delivers_and_closes():
    frames = asyncio.Queue()
    async def write(line):
        await frames.put(decode_line(line))
    transport = StdioBridgeTransport(write, binding_id="binding", provider="slack")
    received = {}
    async def deliver(**kwargs):
        received.update(kwargs)
        received["bytes"] = [open(item.local_path, "rb").read() for item in kwargs["attachments"]]
    transport.deliver_outbound = deliver
    async def call(request_id, method, params, parent=None):
        frame = {"protocol": PROTOCOL, "type": "request", "request_id": request_id, "method": method, "params": params}
        if parent:
            frame["parent_request_id"] = parent
        await transport.receive(frame)
        return await asyncio.wait_for(frames.get(), 2)
    try:
        assert (await call("open-1", "outbound_open", {}))["result"] == {"scope": "open-1"}
        data = b"%PDF-1.4 report"
        ref = (await call("u1", "upload_begin", {"kind": "document", "filename": "report.pdf",
            "mime_type": "application/pdf", "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}, "open-1"))["result"]["reader_ref"]
        await call("u2", "upload_chunk", {"reader_ref": ref, "offset": 0, "data_base64": base64.b64encode(data).decode()}, "open-1")
        await call("u3", "upload_finish", {"reader_ref": ref}, "open-1")
        result = await call("send-1", "deliver", {"scope": "open-1", "conversation_id": "CONE",
                                                  "text": "Report", "attachments": [{"reader_ref": ref}]})
        assert result == {"protocol": PROTOCOL, "type": "result", "request_id": "send-1", "result": {"delivered": True}}
        assert received["conversation_id"] == "CONE" and received["text"] == "Report"
        assert received["bytes"] == [data] and received["attachments"][0].filename == "report.pdf"
        assert "open-1" not in transport._outbound_scopes
        reused = await call("send-2", "deliver", {"scope": "open-1", "conversation_id": "CONE", "text": "again"})
        assert reused["error"] == {"code": "delivery_failed"}
        late = await call("u4", "upload_begin", {"kind": "document", "filename": "x.txt", "size_bytes": 1,
            "sha256": hashlib.sha256(b"x").hexdigest()}, "open-1")
        assert late["error"] == {"code": "artifact_rejected"}
        assert "deliver" in describe()["host_methods"] and describe()["outbound_delivery"]["providers"] == ["slack"]
    finally:
        pending = tuple(transport._host_requests.values())
        transport.close()
        await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_stdio_maps_forbidden_delivery_and_requires_a_capable_bridge():
    frames = asyncio.Queue()
    async def write(line):
        await frames.put(decode_line(line))
    transport = StdioBridgeTransport(write, binding_id="binding", provider="slack")
    await transport.receive({"protocol": PROTOCOL, "type": "request", "request_id": "o", "method": "outbound_open", "params": {}})
    assert (await frames.get())["error"] == {"code": "outbound_rejected"}
    async def forbidden(**kwargs):
        raise PermissionError("no")
    transport.deliver_outbound = forbidden
    await transport.receive({"protocol": PROTOCOL, "type": "request", "request_id": "o", "method": "outbound_open", "params": {}})
    await frames.get()
    await transport.receive({"protocol": PROTOCOL, "type": "request", "request_id": "d", "method": "deliver",
                             "params": {"scope": "o", "conversation_id": "CONE", "text": "hi"}})
    assert (await asyncio.wait_for(frames.get(), 2))["error"] == {"code": "delivery_forbidden"}
    transport.close()
