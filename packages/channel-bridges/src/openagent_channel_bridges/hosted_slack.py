"""Text-only Slack channel using the official service, never a Slack credential.

The injected BridgeTransport remains the host's agent/runtime boundary. The
service session is used only for bound Slack ingress, SDK metadata and egress.
"""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import re
from urllib.parse import urlsplit

from .base import BaseBridge
from .slack import SlackBridge

PROTOCOL = "openagent-slack-channel/v1"
PREFIX = "/v1/channels/slack"
_MAX_RESPONSE = 2 << 20
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_active_delivery = contextvars.ContextVar("hosted_slack_delivery", default=None)


class HostedSlackError(RuntimeError):
    """A fixed diagnostic without response bodies, URLs or credentials."""
    def __init__(self):
        super().__init__("Hosted Slack service request failed")


class HostedSlackSessionExpired(HostedSlackError):
    pass


def _identifier(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _json_object(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise HostedSlackError()
            result[key] = value
        return result
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(HostedSlackError()))
    except (ValueError, UnicodeError, RecursionError):
        raise HostedSlackError() from None
    if not isinstance(value, dict):
        raise HostedSlackError()
    return value


class HostedSlackClient:
    """One delivery's bounded Web API facade; no bot token or global client."""
    def __init__(self, bridge, delivery, channel_id):
        self._bridge = bridge
        self.delivery = delivery
        self.channel_id = channel_id
        self.failed = False
        self.denied = False
        self.runtime_completed = False
        self._post_counter = 0

    async def _call(self, method, arguments, *, write=False):
        if self.failed or self.denied:
            raise HostedSlackError()
        if "channel" in arguments and arguments["channel"] != self.channel_id:
            self.denied = True
            raise PermissionError("Hosted Slack target differs from its binding")
        body = {"delivery_id": self.delivery["id"], "method": method, "arguments": arguments}
        if write:
            event = self.delivery["payload"]["event"]
            expected_thread = event.get("thread_ts") or event["ts"]
            if arguments.get("thread_ts") != expected_thread:
                self.denied = True
                raise PermissionError("Hosted Slack thread differs from its delivery")
            body["operation_id"] = hashlib.sha256(
                f'{self.delivery["id"]}:post:{self._post_counter}'.encode()).hexdigest()
            self._post_counter += 1
        try:
            result = await self._bridge._service_request("POST", "/api", body)
            if result.get("ok") is not True:
                raise HostedSlackError()
            return result
        except asyncio.CancelledError:
            self.failed = True
            raise
        except Exception:
            # Even a response-read failure may follow a completed write. Never
            # continue, ACK or retry this delivery after an unknown outcome.
            self.failed = True
            raise HostedSlackError() from None

    async def auth_test(self):
        return await self._call("auth.test", {})

    async def conversations_info(self, **arguments):
        return await self._call("conversations.info", arguments)

    async def conversations_members(self, **arguments):
        return await self._call("conversations.members", arguments)

    async def conversations_history(self, **arguments):
        return await self._call("conversations.history", arguments)

    async def conversations_replies(self, **arguments):
        return await self._call("conversations.replies", arguments)

    async def chat_postMessage(self, **arguments):
        return await self._call("chat.postMessage", arguments, write=True)


class HostedSlackBridge(SlackBridge):
    """Pull one bound official channel into an explicitly authorized host.

    ``http_client`` is an optional aiohttp-compatible session for fixtures or
    host-configured HTTP transport. It is borrowed and never closed here.
    """
    def __init__(self, *, service_origin, service_binding_id, session_token,
                 transport, binding_id, service_app_id="A0C9XC9JHTK",
                 allowed_users=None, listen_channels=None, personality=None,
                 context_messages=20, live=False, allow_loopback=False,
                 http_client=None):
        try:
            origin = urlsplit(service_origin)
            loopback = allow_loopback and origin.scheme == "http" and origin.hostname in {"127.0.0.1", "localhost", "::1"}
            valid_origin = (origin.scheme == "https" or loopback) and bool(origin.netloc) and origin.username is None and origin.password is None and not origin.path and not origin.query and not origin.fragment
            # urlsplit drops empty query/fragment delimiters; these are not origins.
            valid_origin = valid_origin and "?" not in service_origin and "#" not in service_origin and not any(ord(ch) <= 32 or ord(ch) == 127 for ch in service_origin)
            origin.port
        except (TypeError, ValueError):
            valid_origin = False
        if not valid_origin or not _identifier(service_binding_id) or binding_id != service_binding_id or not _identifier(service_app_id):
            raise ValueError("A fixed official Slack service origin and binding are required")
        if not isinstance(session_token, str) or not session_token or len(session_token) > 16384 or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in session_token):
            raise ValueError("A private hosted Slack service session is required")
        super().__init__(bot_token="", transport=transport, binding_id=binding_id,
                         allowed_users=allowed_users, listen_channels=listen_channels,
                         personality=personality, context_messages=context_messages, live=live)
        self._service_origin = service_origin
        self._service_binding_id = service_binding_id
        self._service_app_id = service_app_id
        self._session_token = session_token
        self._service_http = http_client
        self._owns_service_http = False
        self._session_dead = False
        self._hosted_identity = None
        self._select_bound_channel = listen_channels is None
        self._outcomes = {}

    def _halt_intake(self):
        self._session_dead = True
        if not self._should_stop:
            self._generation += 1
        self._should_stop = True

    async def _service_request(self, method, suffix, body=None):
        if self._session_dead or self._should_stop:
            raise HostedSlackError()
        if self._service_http is None:
            import aiohttp
            self._service_http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25))
            self._owns_service_http = True
        url = f"{self._service_origin}{PREFIX}/bindings/{self._service_binding_id}{suffix}"
        try:
            async with asyncio.timeout(25):
                async with self._service_http.request(method, url,
                        headers={"Authorization": f"Bearer {self._session_token}"},
                        json=body, allow_redirects=False) as response:
                    if response.status == 403:
                        self._halt_intake()
                        raise HostedSlackSessionExpired()
                    if not 200 <= response.status < 300:
                        raise HostedSlackError()
                    chunks, size = [], 0
                    while chunk := await response.content.read(65536):
                        size += len(chunk)
                        if size > _MAX_RESPONSE:
                            raise HostedSlackError()
                        chunks.append(chunk)
                    return _json_object(b"".join(chunks))
        except HostedSlackError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            raise HostedSlackError() from None

    def _validate_inbox(self, result):
        binding = result.get("binding")
        deliveries = result.get("deliveries")
        if result.get("protocol") != PROTOCOL or not isinstance(binding, dict) or not isinstance(deliveries, list) or len(deliveries) > 100:
            raise HostedSlackError()
        if binding.get("id") != self._service_binding_id or binding.get("status") != "active" or any(not _identifier(binding.get(field)) for field in ("team_id", "channel_id", "bot_user_id")) or type(binding.get("version")) is not int or binding["version"] <= 0:
            raise HostedSlackError()
        identity = tuple(binding[field] for field in ("team_id", "channel_id", "bot_user_id", "version"))
        if self._hosted_identity is not None and identity != self._hosted_identity:
            raise HostedSlackError()
        seen = set()
        # This hash identifies the service's verified original Slack bytes.
        # JSON objects may be re-encoded in transit; never claim a new dumps()
        # value authenticates or reproduces that original wire body.
        for delivery in deliveries:
            if not isinstance(delivery, dict) or not _identifier(delivery.get("id")) or delivery["id"] in seen or delivery.get("binding_id") != self._service_binding_id or delivery.get("team_id") != binding["team_id"] or type(delivery.get("binding_version")) is not int or delivery["binding_version"] != binding["version"] or delivery.get("status") != "pending" or not isinstance(delivery.get("body_sha256"), str) or _HASH.fullmatch(delivery["body_sha256"]) is None:
                raise HostedSlackError()
            seen.add(delivery["id"])
            payload = delivery.get("payload")
            if not isinstance(payload, dict) or payload.get("type") != "event_callback" or payload.get("api_app_id") != self._service_app_id or payload.get("team_id") != binding["team_id"] or not _identifier(delivery.get("event_id")) or payload.get("event_id") != delivery["event_id"]:
                raise HostedSlackError()
            event = payload.get("event")
            if not isinstance(event, dict) or event.get("channel") != binding["channel_id"] or event.get("team", binding["team_id"]) != binding["team_id"] or not _identifier(event.get("user")):
                raise HostedSlackError()
            if (not isinstance(event.get("text", ""), str)
                    or not isinstance(event.get("ts"), str)
                    or re.fullmatch(r"[0-9]{1,20}\.[0-9]{1,10}", event["ts"]) is None
                    or event.get("thread_ts") is not None and (not isinstance(event["thread_ts"], str)
                        or re.fullmatch(r"[0-9]{1,20}\.[0-9]{1,10}", event["thread_ts"]) is None)):
                raise HostedSlackError()
            previous = self._outcomes.get(delivery["id"])
            if previous and previous[0] != delivery["body_sha256"]:
                raise HostedSlackError()
        self._hosted_identity = identity
        self._account_id, self._bot_user_id = binding["team_id"], binding["bot_user_id"]
        if self._select_bound_channel:
            self.listen_channels = {binding["channel_id"]}
        return binding, deliveries

    def _current_delivery_client(self):
        client = _active_delivery.get()
        return client if client is not None and client._bridge is self else None

    async def authorize_context(self, context):
        try:
            await super().authorize_context(context)
        except PermissionError:
            client = self._current_delivery_client()
            if client is not None:
                client.denied = True
            raise

    async def _prepare_delivery_context(self, context):
        try:
            return await super()._prepare_delivery_context(context)
        except PermissionError:
            client = self._current_delivery_client()
            if client is not None:
                client.denied = True
            raise

    async def send_message(self, *args, **kwargs):
        client = self._current_delivery_client()
        try:
            result = await super().send_message(*args, **kwargs)
            if any(part.attachment is not None for part in result.get("_typed_parts", ())):
                if client is not None:
                    client.denied = True
                raise PermissionError("Hosted Slack supports text only")
            if client is not None:
                if result.get("type") in {"response", "duplicate"}:
                    client.runtime_completed = True
                else:
                    client.failed = True
            return result
        except PermissionError:
            if client is not None:
                client.denied = True
            raise
        except BaseException:
            if client is not None:
                client.failed = True
            raise

    async def send_text_chunk(self, target, chunk):
        arguments = {"channel": target.channel, "text": chunk}
        if target.thread_ts:
            arguments["thread_ts"] = target.thread_ts
        await target.client.chat_postMessage(**arguments)

    async def send_attachment(self, target, attachment):
        self._deny_unsupported()

    async def render_picker(self, target, picker):
        self._deny_unsupported()

    async def send_choice_buttons(self, target, options):
        self._deny_unsupported()

    def _deny_unsupported(self):
        client = self._current_delivery_client()
        if client is not None:
            client.denied = True
        raise PermissionError("Hosted Slack supports text only")

    async def poll_once(self):
        """One serial bounded poll; there is no fabricated parent intake API."""
        if self._session_dead or self._should_stop:
            raise HostedSlackError()
        try:
            result = await self._service_request("GET", "/inbox")
            binding, deliveries = self._validate_inbox(result)
            for delivery in deliveries:
                previous = self._outcomes.get(delivery["id"])
                if previous:
                    outcome = previous[1]
                else:
                    if len(self._outcomes) >= 4096:
                        raise HostedSlackError()
                    client = HostedSlackClient(self, delivery, binding["channel_id"])
                    event = delivery["payload"]["event"]
                    token = _active_delivery.set(client)
                    try:
                        is_dm = self._is_dm_channel(event["channel"], event.get("channel_type", ""))
                        mention = f"<@{self._bot_user_id}>"
                        text = event.get("text", "").strip()
                        substantive = text[len(mention):].lstrip(": ").strip() if text.startswith(mention) else text
                        if (event.get("files") or event.get("bot_id") or event.get("subtype") is not None
                                or event.get("type") not in {"app_mention", "message"} or not substantive
                                or event["user"] == self._bot_user_id or not self._is_authorized(event["user"])
                                or not self._channel_listened(event["channel"], is_dm)
                                or not is_dm and mention not in text):
                            client.denied = True
                        else:
                            await self.handle_event(event, client, account_id=binding["team_id"], event_id=delivery["event_id"])
                            if not client.runtime_completed and not client.denied:
                                client.failed = True
                    except PermissionError:
                        client.denied = True
                    finally:
                        _active_delivery.reset(token)
                    if client.failed:
                        raise HostedSlackError()
                    outcome = "denied" if client.denied else "accepted"
                    self._outcomes[delivery["id"]] = (delivery["body_sha256"], outcome)
                await self._service_request("POST", "/ack", {
                    "delivery_id": delivery["id"], "body_sha256": delivery["body_sha256"], "outcome": outcome})
        except BaseException:
            self._halt_intake()
            raise

    async def _close_service_http(self):
        if self._owns_service_http and self._service_http is not None:
            session, self._service_http = self._service_http, None
            self._owns_service_http = False
            await session.close()

    async def _run(self):
        try:
            while not self._should_stop:
                try:
                    await self.poll_once()
                except HostedSlackError:
                    return
                await asyncio.sleep(1)
        finally:
            await self._close_service_http()

    async def stop(self):
        # Close only this bridge's runtime connection and its own HTTP session.
        # No Slack SDK session, local bot credential or host Runtime is owned.
        try:
            await BaseBridge.stop(self)
        finally:
            await self._close_service_http()
