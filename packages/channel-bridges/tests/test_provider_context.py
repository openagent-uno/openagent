"""Provider parsing/history with real shared orchestration, no provider SDK IO."""
from __future__ import annotations

from types import SimpleNamespace
import unittest

from openagent_channel_bridges.contracts import BridgeCapabilities, BridgePart, BridgeReply
from openagent_channel_bridges.discord import DiscordBridge
from openagent_channel_bridges.history import history_size_bytes, render_history
from openagent_channel_bridges.slack import SlackBridge


class Transport:
    def __init__(self):
        self.allowed = True
        self.checked = []
        self.requests = []

    async def authorize_context(self, context):
        self.checked.append(context)
        return self.allowed

    async def start(self):
        return BridgeCapabilities()

    async def stop(self):
        pass

    async def send(self, request, **callbacks):
        self.requests.append(request)
        return BridgeReply(parts=(BridgePart(text="fixture reply"),))


class SlackClient:
    def __init__(self, pages=(), *, revoke=None, incomplete=False):
        self.pages = list(pages)
        self.calls = []
        self.posts = []
        self.revoke = revoke
        self.incomplete = incomplete

    async def conversations_history(self, **kwargs):
        self.calls.append(("history", kwargs))
        if self.revoke:
            self.revoke()
        return {"messages": self.pages[0] if self.pages else []}

    async def conversations_replies(self, **kwargs):
        self.calls.append(("replies", kwargs))
        index = len(self.calls) - 1
        if self.revoke:
            self.revoke()
        more = self.incomplete or index + 1 < len(self.pages)
        return {"messages": self.pages[index] if index < len(self.pages) else [],
                "response_metadata": {"next_cursor": f"cursor-{index + 1}" if more else ""},
                "has_more": more}

    async def chat_postMessage(self, **kwargs):
        self.posts.append(kwargs)


def slack_event(*, event_type="app_mention", channel="Cfixture", thread=None, text="<@BOT> current question"):
    value = {"type": event_type, "channel": channel, "user": "Uactor", "text": text, "ts": "50.000001"}
    if thread:
        value["thread_ts"] = thread
    return value


class DiscordChannel:
    def __init__(self, channel_id="33", *, parent_id=None):
        self.id = int(channel_id)
        self.parent_id = parent_id
        self.messages = []
        self.calls = []
        self.revoke = None

    def history(self, **kwargs):
        self.calls.append(kwargs)

        async def items():
            for message in self.messages:
                if self.revoke:
                    self.revoke()
                yield message
        return items()


def discord_message(channel, event, *, text="message", actor="7", guild="22"):
    return SimpleNamespace(id=int(event), content=text, author=SimpleNamespace(id=int(actor)),
        channel=channel, guild=SimpleNamespace(id=int(guild)) if guild else None,
        reference=None, created_at=None)


class ProviderContextTests(unittest.IsolatedAsyncioTestCase):
    def slack(self, *, count=20):
        transport = Transport()
        bridge = SlackBridge("synthetic-bot-token", transport=transport, binding_id="binding-slack",
                             allowed_users=["Uactor"], listen_channels=["Cfixture"],
                             context_messages=count, live=False)
        bridge._bot_user_id = "BOT"
        bridge._account_id = "Tfixture"
        return bridge, transport

    async def test_slack_mention_preserves_actor_thread_and_latest_history(self):
        bridge, transport = self.slack(count=2)
        pages = [
            [{"ts": "10.0", "user": "Uold", "text": "old root"},
             {"ts": "11.0", "thread_ts": "10.0", "user": "Uold", "text": "old prefix"}],
            [{"ts": "49.0", "thread_ts": "10.0", "user": "Uother", "text": "newest"},
             {"ts": "48.0", "thread_ts": "10.0", "user": "Uactor", "text": "earlier"},
             {"ts": "49.5", "thread_ts": "wrong-thread", "user": "Uother", "text": "foreign"},
             {"ts": "50.000001", "thread_ts": "10.0", "user": "Uactor", "text": "trigger duplicate"}],
        ]
        client = SlackClient(pages)
        await bridge.handle_event(slack_event(thread="10.0"), client, account_id="Tfixture", event_id="Ev-trigger")
        self.assertEqual(len(transport.requests), 1)
        request = transport.requests[0]
        self.assertEqual((request.context.binding_id, request.context.actor_id, request.context.account_id,
                          request.context.conversation_id, request.context.thread_id, request.context.event_id),
                         ("binding-slack", "Uactor", "Tfixture", "Cfixture", "10.0", "Ev-trigger"))
        self.assertEqual(request.parts[0].text, "current question")
        self.assertEqual([m.event_id for m in request.history], ["48.0", "49.0"])
        self.assertEqual([kind for kind, _ in client.calls], ["replies", "replies"])
        self.assertTrue(all(v["channel"] == "Cfixture" and v["ts"] == "10.0" and v["latest"] == "50.000001" for _, v in client.calls))
        self.assertIn("untrusted", render_history(request.history))
        self.assertLessEqual(history_size_bytes(request.history), 65536)
        self.assertTrue(client.posts)
        self.assertTrue(all(p["channel"] == "Cfixture" and p["thread_ts"] == "10.0" for p in client.posts))

    async def test_slack_denied_binding_does_not_fetch_or_deliver(self):
        bridge, transport = self.slack()
        transport.allowed = False
        client = SlackClient()
        with self.assertRaises(PermissionError):
            await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-denied")
        self.assertEqual((client.calls, client.posts, transport.requests), ([], [], []))

    async def test_slack_ignores_unmentioned_or_unlisted_channel(self):
        bridge, transport = self.slack()
        client = SlackClient()
        for event in (slack_event(text="ordinary channel text"), slack_event(channel="Cforeign")):
            await bridge.handle_event(event, client, account_id="Tfixture", event_id="Ev-ignored")
        self.assertEqual((client.calls, client.posts, transport.requests), ([], [], []))

    async def test_slack_rechecks_after_history_before_transport_or_reply(self):
        bridge, transport = self.slack()
        client = SlackClient(revoke=lambda: setattr(transport, "allowed", False))
        await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-revoked")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual((client.posts, transport.requests), ([], []))

    async def test_slack_incomplete_thread_omits_old_prefix_with_finite_calls(self):
        bridge, transport = self.slack()
        client = SlackClient([[{"ts": "10.0", "user": "Uold", "text": "old prefix"}]], incomplete=True)
        await bridge.handle_event(slack_event(thread="10.0"), client, account_id="Tfixture", event_id="Ev-bounded")
        self.assertEqual(len(client.calls), 10)
        self.assertEqual(transport.requests[0].history, ())
        self.assertTrue(all(kind == "replies" for kind, _ in client.calls))

    async def test_slack_zero_context_makes_no_history_calls(self):
        bridge, transport = self.slack(count=0)
        client = SlackClient()
        await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-no-history")
        self.assertEqual(client.calls, [])
        self.assertEqual(transport.requests[0].history, ())

    async def test_slack_unicode_context_is_byte_bounded_and_trigger_excluded(self):
        bridge, transport = self.slack(count=100)
        client = SlackClient([[{"ts": str(n), "user": "Uactor", "text": "界" * 10000} for n in (46, 47, 48, 49)]])
        await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-unicode")
        history = transport.requests[0].history
        self.assertEqual([m.event_id for m in history], ["48", "49"])
        self.assertLessEqual(history_size_bytes(history), 65536)

    async def test_discord_thread_history_is_exact_chronological_and_authorized(self):
        transport = Transport()
        bridge = DiscordBridge("synthetic-token", allowed_guilds=["22"], listen_channels=["33"],
            transport=transport, binding_id="binding-discord", context_messages=2)
        channel = DiscordChannel(parent_id=30)
        trigger = discord_message(channel, 50)
        channel.messages = [discord_message(channel, 49, text="new"),
            discord_message(DiscordChannel("34"), 48, text="wrong channel"),
            discord_message(channel, 48, text="old"), trigger,
            discord_message(channel, 47, guild="23", text="wrong guild")]
        context = bridge._bridge_context(trigger)
        history = await bridge._history(trigger, context)
        self.assertEqual((context.account_id, context.actor_id, context.conversation_id, context.thread_id), ("22", "7", "33", "33"))
        self.assertEqual([m.event_id for m in history], ["48", "49"])
        self.assertEqual(len(channel.calls), 1)
        self.assertIs(channel.calls[0]["before"], trigger)
        self.assertFalse(channel.calls[0]["oldest_first"])
        await bridge.send_message("current", context=context, history=history)
        self.assertEqual(transport.requests[0].history, history)
        self.assertEqual(transport.requests[0].context, context)

    async def test_discord_denied_or_revoked_context_never_reaches_transport(self):
        transport = Transport()
        bridge = DiscordBridge("synthetic-token", listen_channels=["33"],
            transport=transport, binding_id="binding-discord")
        channel = DiscordChannel()
        trigger = discord_message(channel, 50)
        context = bridge._bridge_context(trigger)
        transport.allowed = False
        with self.assertRaises(PermissionError):
            await bridge._history(trigger, context)
        self.assertEqual(channel.calls, [])
        transport.allowed = True
        channel.messages = [discord_message(channel, 49)]
        channel.revoke = lambda: setattr(transport, "allowed", False)
        with self.assertRaises(PermissionError):
            await bridge._history(trigger, context)
        self.assertEqual(transport.requests, [])

    def test_context_limits_reject_bool_out_of_range_and_non_integer(self):
        for value in (-1, 101, True, 1.0, "20"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.slack(count=value)
