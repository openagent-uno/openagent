"""Real shared Slack orchestration over a fake official-service HTTP boundary."""
import copy
import hashlib
import json

import pytest

from openagent_channel_bridges.contracts import BridgeCapabilities, BridgePart, BridgeReply
from openagent_channel_bridges.hosted_slack import (
    HostedSlackBridge, HostedSlackError, HostedSlackSessionExpired, PREFIX, PROTOCOL,
)

TOKEN = "private-service-session-canary"


class HostTransport:
    def __init__(self):
        self.allowed = True
        self.delivery_allowed = True
        self.requests = []
        self.checked_audiences = []
        self.stops = 0

    async def authorize_context(self, context):
        return self.allowed and context.binding_id == "binding" and context.actor_id == "Uactor"

    async def authorize_delivery(self, context):
        self.checked_audiences.append(context)
        return self.delivery_allowed and context.audience_complete and context.audience_ids == ("Uactor", "Uother")

    async def start(self):
        return BridgeCapabilities()

    async def stop(self):
        self.stops += 1

    async def send(self, request, **callbacks):
        self.requests.append(request)
        return BridgeReply(parts=(BridgePart(text="host reply"),))


class Content:
    def __init__(self, data):
        self.data = data

    async def read(self, size):
        chunk, self.data = self.data[:size], self.data[size:]
        return chunk


class Response:
    def __init__(self, value=None, *, status=200, raw=None):
        self.status = status
        self.content = Content(raw if raw is not None else json.dumps(value).encode())

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


def inbox():
    return {"protocol": PROTOCOL,
        "binding": {"id": "binding", "team_id": "Tfixture", "channel_id": "Cfixture",
                    "bot_user_id": "BOT", "status": "active", "version": 1},
        "deliveries": [{"id": "delivery", "event_id": "Evfixture", "team_id": "Tfixture",
            "binding_id": "binding", "binding_version": 1, "body_sha256": "a" * 64,
            "status": "pending", "payload": {"type": "event_callback", "api_app_id": "A0C9XC9JHTK",
                "team_id": "Tfixture", "event_id": "Evfixture",
                "event": {"type": "app_mention", "channel": "Cfixture", "channel_type": "channel",
                          "user": "Uactor", "text": "<@BOT> question", "ts": "50.000001"}}}]}


class ServiceHTTP:
    def __init__(self, value=None):
        self.inbox = value if value is not None else inbox()
        self.calls = []
        self.api = []
        self.posts = []
        self.acks = []
        self.closed = 0
        self.status = 200
        self.fail_write = False
        self.raw = None

    def request(self, method, url, *, headers, json, allow_redirects):
        assert headers == {"Authorization": f"Bearer {TOKEN}"}
        assert allow_redirects is False
        assert url.startswith("https://service.invalid" + PREFIX + "/bindings/binding/")
        suffix = url.rsplit("/", 1)[-1]
        self.calls.append((method, suffix))
        if suffix == "inbox":
            assert method == "GET" and json is None
            return Response(self.inbox, status=self.status, raw=self.raw)
        assert method == "POST"
        if suffix == "ack":
            self.acks.append(json)
            return Response({"status": "acknowledged"})
        assert suffix == "api" and json["delivery_id"] == "delivery"
        self.api.append(json)
        name, args = json["method"], json["arguments"]
        if name == "auth.test":
            return Response({"ok": True, "team_id": "Tfixture", "user_id": "BOT"})
        if name == "conversations.members":
            assert args["channel"] == "Cfixture"
            return Response({"ok": True, "members": ["BOT", "Uactor", "Uother"], "response_metadata": {"next_cursor": ""}})
        if name in {"conversations.history", "conversations.replies"}:
            assert args["channel"] == "Cfixture"
            return Response({"ok": True, "messages": [{"user": "Uother", "ts": "49.000001", "text": "previous"}], "has_more": False})
        if name == "chat.postMessage":
            self.posts.append(json)
            if self.fail_write:
                raise RuntimeError("PRIVATE_BODY /private/path " + TOKEN)
            return Response({"ok": True, "channel": "Cfixture", "ts": "51.000001"})
        raise AssertionError("Unexpected provider operation")

    async def close(self):
        self.closed += 1


def bridge(http=None, transport=None, **kwargs):
    return HostedSlackBridge(service_origin="https://service.invalid", service_binding_id="binding",
        session_token=TOKEN, transport=transport or HostTransport(), binding_id="binding",
        http_client=http or ServiceHTTP(), **kwargs)


@pytest.mark.asyncio
async def test_hosted_normal_bridge_preserves_host_context_history_and_ack_after_reply():
    http, transport = ServiceHTTP(), HostTransport()
    current = bridge(http, transport)
    await current.poll_once()
    assert current.bot_token == "" and current.app_token is None
    assert len(transport.requests) == 1
    request = transport.requests[0]
    assert (request.context.binding_id, request.context.account_id, request.context.actor_id,
            request.context.conversation_id, request.context.event_id) == ("binding", "Tfixture", "Uactor", "Cfixture", "Evfixture")
    assert request.context.audience_complete and request.context.audience_ids == ("Uactor", "Uother")
    assert request.parts[0].text == "question" and request.history[0].parts[0].text == "previous"
    assert http.posts[0]["arguments"] == {"channel": "Cfixture", "text": "host reply"}
    assert http.posts[0]["operation_id"] == hashlib.sha256(b"delivery:post:0").hexdigest()
    assert http.calls[-1] == ("POST", "ack")
    assert http.acks == [{"delivery_id": "delivery", "body_sha256": "a" * 64, "outcome": "accepted"}]
    api_count = len(http.api)
    await current.poll_once()  # Lost ACK/redelivery must not start another host run or write.
    assert len(transport.requests) == len(http.posts) == 1 and len(http.api) == api_count
    await current.stop()
    assert http.closed == 0  # An injected HTTP transport is borrowed.


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["team", "channel", "app", "event", "binding", "hash", "version"])
async def test_hosted_envelope_mismatch_never_reaches_runtime_or_provider(mismatch):
    value = inbox(); delivery = value["deliveries"][0]
    if mismatch == "team": delivery["payload"]["team_id"] = "OTHER"
    elif mismatch == "channel": delivery["payload"]["event"]["channel"] = "OTHER"
    elif mismatch == "app": delivery["payload"]["api_app_id"] = "OTHER"
    elif mismatch == "event": delivery["payload"]["event_id"] = "OTHER"
    elif mismatch == "binding": delivery["binding_id"] = "OTHER"
    elif mismatch == "hash": delivery["body_sha256"] = "not-a-hash"
    else: delivery["binding_version"] = True
    http, transport = ServiceHTTP(value), HostTransport()
    current = bridge(http, transport)
    with pytest.raises(HostedSlackError):
        await current.poll_once()
    assert not transport.requests and not http.api and not http.acks
    await current.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [403, 307])
async def test_session_expiry_or_redirect_stops_intake_without_forwarding(status, caplog):
    http, transport = ServiceHTTP(), HostTransport(); http.status = status
    http.raw = json.dumps({"error": TOKEN, "location": "https://other.invalid/?secret=" + TOKEN}).encode()
    current = bridge(http, transport)
    with pytest.raises(HostedSlackError) as error:
        await current.poll_once()
    if status == 403:
        assert isinstance(error.value, HostedSlackSessionExpired)
    with pytest.raises(HostedSlackError):
        await current.poll_once()
    assert http.calls == [("GET", "inbox")] and not transport.requests
    assert TOKEN not in str(error.value) and TOKEN not in caplog.text
    await current.stop()


@pytest.mark.asyncio
async def test_unknown_write_outcome_is_not_retried_or_acknowledged(caplog):
    http, transport = ServiceHTTP(), HostTransport(); http.fail_write = True
    current = bridge(http, transport)
    with pytest.raises(HostedSlackError) as error:
        await current.poll_once()
    assert len(http.posts) == 1 and len(transport.requests) == 1 and not http.acks
    with pytest.raises(HostedSlackError):
        await current.poll_once()
    assert len(http.posts) == 1
    assert TOKEN not in str(error.value) and TOKEN not in caplog.text and "PRIVATE_BODY" not in caplog.text
    await current.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("denial", ["files", "actor", "audience"])
async def test_unsupported_media_or_host_denial_is_acknowledged_denied_without_model(denial):
    http, transport = ServiceHTTP(), HostTransport()
    if denial == "files":
        http.inbox["deliveries"][0]["payload"]["event"]["files"] = [{"url_private": "https://slack.com/private"}]
    elif denial == "actor": transport.allowed = False
    else: transport.delivery_allowed = False
    current = bridge(http, transport)
    await current.poll_once()
    assert not transport.requests and not http.posts
    assert http.acks[0]["outcome"] == "denied"
    if denial == "files": assert not http.api
    await current.stop()


@pytest.mark.asyncio
async def test_oversized_response_and_binding_drift_are_closed_before_submission():
    http, transport = ServiceHTTP(), HostTransport()
    http.raw = b" " * ((2 << 20) + 1)
    current = bridge(http, transport)
    with pytest.raises(HostedSlackError):
        await current.poll_once()
    assert not transport.requests and not http.api and not http.acks
    await current.stop()
    http, transport = ServiceHTTP(), HostTransport(); current = bridge(http, transport)
    await current.poll_once()
    http.inbox = copy.deepcopy(http.inbox)
    http.inbox["binding"]["team_id"] = "OTHER"
    http.inbox["deliveries"] = []
    with pytest.raises(HostedSlackError):
        await current.poll_once()
    assert len(transport.requests) == 1
    await current.stop()


@pytest.mark.parametrize("origin", ["http://service.invalid", "https://service.invalid/path", "https://service.invalid?token=x", "https://user:secret@service.invalid", "https://service.invalid#fragment"])
def test_unsafe_service_origins_are_rejected_without_http(origin):
    with pytest.raises(ValueError):
        HostedSlackBridge(service_origin=origin, service_binding_id="binding", session_token=TOKEN,
                          transport=HostTransport(), binding_id="binding")
