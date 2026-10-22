"""Provider parsing/history with real shared orchestration, no provider SDK IO."""
from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from openagent_channel_bridges.contracts import BridgeCapabilities, BridgePart, BridgeReply
from openagent_channel_bridges.discord import DiscordBridge
from openagent_channel_bridges.history import history_size_bytes, render_history
from openagent_channel_bridges.slack import SlackBridge
from openagent_channel_bridges.telegram import TelegramBridge


class Transport:
    def __init__(self):
        self.allowed = True
        self.checked = []
        self.requests = []
        self.deliveries = []
        self.delivery_policy = lambda context: True
        self.before_reply = None
        self.reply_text = "fixture reply"

    async def authorize_context(self, context):
        self.checked.append(context)
        return self.allowed

    async def authorize_delivery(self, context):
        self.deliveries.append(context)
        return self.allowed and self.delivery_policy(context)

    async def start(self):
        return BridgeCapabilities()

    async def stop(self):
        pass

    async def send(self, request, **callbacks):
        self.requests.append(request)
        if self.before_reply:
            self.before_reply()
        return BridgeReply(parts=(BridgePart(text=self.reply_text),))


class SlackClient:
    def __init__(self, pages=(), *, revoke=None, incomplete=False):
        self.pages = list(pages)
        self.calls = []
        self.posts = []
        self.revoke = revoke
        self.incomplete = incomplete
        self.members = ["BOT", "Uactor", "Uother"]
        self.member_pages = None
        self.member_calls = []
        self.auth_calls = 0
        self.account = "Tfixture"
        self.member_error = None
        self.after_members = None
        self.info_user = "Uactor"
        self.after_post = None

    async def auth_test(self):
        self.auth_calls += 1
        return {"ok": True, "team_id": self.account, "user_id": "BOT"}

    async def conversations_info(self, *, channel):
        return {"ok": True, "channel": {"id": channel, "is_im": True, "user": self.info_user}}

    async def conversations_members(self, **kwargs):
        self.member_calls.append(kwargs)
        if self.member_error:
            raise self.member_error
        page = int(kwargs.get("cursor", "0"))
        pages = self.member_pages or [self.members]
        if self.after_members:
            self.after_members()
        return {"ok": True, "members": pages[page],
                "response_metadata": {"next_cursor": str(page + 1) if page + 1 < len(pages) else ""}}

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
        if self.after_post:
            self.after_post()


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
        self.posts = []
        self.guild = None
        self.visible = None

    async def send(self, text):
        self.posts.append(text)

    def permissions_for(self, member):
        return SimpleNamespace(view_channel=self.visible is None or str(member.id) in self.visible)

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


class RestGuild:
    def __init__(self, channel, members=(7, 8, 999)):
        self.id = 22
        self.channel = channel
        channel.guild = self
        self.members_to_fetch = list(members)
        self.calls = []
        self.on_member = None
        self.role_assignments = {}
        self.raw_guild = {"id": "22", "owner_id": "90", "roles": [
            {"id": "22", "permissions": str((1 << 10) | (1 << 11) | (1 << 16) | (1 << 38))},
            {"id": "40", "permissions": str(1 << 34)},
            {"id": "41", "permissions": str(1 << 3)},
        ]}
        self.raw_channel = {"id": str(channel.id), "guild_id": "22", "type": 0, "permission_overwrites": []}
        self.raw_parent = None
        if channel.parent_id is not None:
            self.raw_channel = {"id": str(channel.id), "guild_id": "22", "type": 11,
                                "parent_id": str(channel.parent_id), "thread_metadata": {"archived": False, "locked": False}}
            self.raw_parent = {"id": str(channel.parent_id), "guild_id": "22", "type": 0, "permission_overwrites": []}
        self.joined = [7, 999]
        self.thread_pages = None
        self.after_rest = None

    def member(self, member):
        return {"user": {"id": str(member)}, "roles": self.role_assignments.get(str(member), [])}

    async def rest(self, context, path, *, params=None):
        self.calls.append((path, params))
        if path == "/guilds/22":
            value = self.raw_guild
        elif path == "/guilds/22/members":
            after = int((params or {}).get("after", "0"))
            value = [self.member(member) for member in sorted(self.members_to_fetch)
                     if int(member) > after][:params["limit"]]
            if self.on_member:
                self.on_member()
        elif path == "/channels/33/thread-members":
            if self.thread_pages is not None:
                cursor = (params or {}).get("after")
                value = self.thread_pages[cursor]
            else:
                after = int((params or {}).get("after", "0"))
                value = [{"id": "33", "user_id": str(member), "member": self.member(member)}
                         for member in sorted(self.joined) if int(member) > after][:params["limit"]]
        elif path == "/channels/33":
            value = self.raw_channel
            if self.channel.visible is not None and self.channel.parent_id is None:
                value = copy.deepcopy(value)
                value["permission_overwrites"].extend({"id": str(member), "type": 1, "allow": "0", "deny": str(1 << 10)}
                    for member in self.members_to_fetch if str(member) not in self.channel.visible)
        elif self.raw_parent is not None and path == f"/channels/{self.raw_parent['id']}":
            value = self.raw_parent
        else:
            raise AssertionError("Unexpected provider endpoint " + path)
        result = copy.deepcopy(value)
        if self.after_rest:
            self.after_rest(path, params)
        return result

    async def fetch_channel(self, channel_id):
        self.calls.append(("channel", channel_id))
        return self.channel

    def fetch_members(self, *, limit):
        self.calls.append(("members", limit))

        async def items():
            for member in self.members_to_fetch[:limit]:
                if self.on_member:
                    self.on_member()
                yield SimpleNamespace(id=member, guild=self)
        return items()


class DiscordClient:
    def __init__(self, guild):
        self.guild = guild
        self.user = SimpleNamespace(id=999)
        self.intents = SimpleNamespace(members=True)
        self.calls = []

    async def fetch_guild(self, guild_id):
        self.calls.append(("guild", guild_id))
        return self.guild

    async def fetch_channel(self, channel_id):
        self.calls.append(("direct", channel_id))
        return self.guild.channel

    def get_guild(self, guild_id):
        raise AssertionError("cached guild must not attest audience")


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
        bridge, transport, channel, _ = self.discord(parent_id=30)
        bridge.context_messages = 2
        trigger = discord_message(channel, 50)
        channel.messages = [discord_message(channel, 49, text="new"),
            discord_message(DiscordChannel("34"), 48, text="wrong channel"),
            discord_message(channel, 48, text="old"), trigger,
            discord_message(channel, 47, guild="23", text="wrong guild")]
        context = bridge._bridge_context(trigger)
        history = await bridge._history(trigger, context)
        self.assertEqual((context.account_id, context.actor_id, context.conversation_id, context.thread_id), ("22", "7", "30", "33"))
        self.assertEqual([m.event_id for m in history], ["48", "49"])
        self.assertEqual(len(channel.calls), 1)
        self.assertIs(channel.calls[0]["before"], trigger)
        self.assertFalse(channel.calls[0]["oldest_first"])
        await bridge.send_message("current", context=context, history=history)
        request = transport.requests[0]
        self.assertEqual(request.context.conversation_kind, "thread")
        self.assertEqual(request.context.audience_ids, ("7", "8"))
        self.assertEqual([m.event_id for m in request.history], ["48", "49"])

    async def test_discord_denied_or_revoked_context_never_reaches_transport(self):
        bridge, transport, channel, _ = self.discord()
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

    async def test_slack_attests_members_via_api_and_excludes_only_verified_self_bot(self):
        bridge, transport = self.slack(count=0)
        client = SlackClient()
        client.member_pages = [["Uactor", "BOT"], ["Uother", "Bnot-self"]]
        event = slack_event()
        event["audience_ids"] = ["payload-is-not-audience"]
        await bridge.handle_event(event, client, account_id="Tfixture", event_id="Ev-members")
        self.assertEqual(len(transport.requests), 1)
        context = transport.requests[0].context
        self.assertEqual(context.conversation_kind, "channel")
        self.assertEqual(context.audience_ids, ("Bnot-self", "Uactor", "Uother"))
        self.assertTrue(context.audience_complete)
        self.assertIsNotNone(context.audience_verified_at)
        self.assertGreater(client.auth_calls, 1)  # Before RPC, then again before output.
        self.assertEqual(client.member_calls[0], {"channel": "Cfixture", "limit": 100})
        self.assertEqual(client.member_calls[1]["cursor"], "1")
        self.assertTrue(all(c.audience_complete for c in transport.deliveries))
        self.assertEqual(bridge._event_clients, {})

    async def test_slack_unknown_actor_errors_and_pagination_cap_never_dispatch(self):
        for case in ("unknown-actor", "error", "overflow", "wrong-account"):
            with self.subTest(case=case):
                bridge, transport = self.slack(count=0)
                client = SlackClient()
                if case == "unknown-actor":
                    client.members = ["BOT", "Uother"]
                elif case == "error":
                    client.member_error = RuntimeError("synthetic secret must never be logged")
                elif case == "overflow":
                    client.member_pages = [[f"U{page}-{n}" for n in range(100)] for page in range(11)]
                    client.member_pages[0][0] = "Uactor"
                else:
                    client.account = "Tforeign"
                await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-incomplete")
                self.assertEqual((transport.requests, client.posts), ([], []))
                self.assertLessEqual(len(client.member_calls), 10)
                self.assertEqual(bridge._event_clients, {})
                self.assertEqual(bridge._audience_denied_events, set())

    async def test_slack_direct_recipient_is_sdk_verified_not_payload_audience(self):
        bridge, transport = self.slack(count=0)
        client = SlackClient()
        event = slack_event(channel="Dfixture", event_type="message", text="direct question")
        await bridge.handle_event(event, client, account_id="Tfixture", event_id="Ev-direct")
        context = transport.requests[0].context
        self.assertEqual((context.conversation_kind, context.audience_ids, context.audience_complete),
                         ("direct", ("Uactor",), True))
        self.assertEqual(client.member_calls, [])
        bridge, transport = self.slack(count=0)
        client.info_user = "Udifferent"
        await bridge.handle_event(event, client, account_id="Tfixture", event_id="Ev-wrong-direct")
        self.assertEqual(transport.requests, [])

    async def test_slack_membership_changes_during_model_are_rechecked_before_egress(self):
        bridge, transport = self.slack(count=0)
        client = SlackClient()
        transport.delivery_policy = lambda context: "Unew" not in context.audience_ids
        transport.before_reply = lambda: client.members.append("Unew")
        await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-new-member")
        self.assertEqual(len(transport.requests), 1)
        self.assertNotIn("Unew", transport.requests[0].context.audience_ids)
        # The pinned conversation epoch blocks before a new delivery grant.
        self.assertNotIn("Unew", transport.deliveries[-1].audience_ids)
        self.assertGreater(len(client.member_calls), 1)
        self.assertEqual(client.posts, [])
        self.assertEqual(bridge._event_clients, {})

    async def test_slack_each_output_chunk_rechecks_membership(self):
        bridge, transport = self.slack(count=0)
        client = SlackClient()
        transport.reply_text = "x" * 7100
        transport.delivery_policy = lambda context: "Unew" not in context.audience_ids
        client.after_post = lambda: client.members.append("Unew")
        await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-chunks")
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(len(client.posts), 1)
        self.assertLess(len(client.posts[0]["text"]), len(transport.reply_text))
        self.assertNotIn("Unew", transport.deliveries[-1].audience_ids)
        self.assertGreater(len(client.member_calls), 1)

    async def test_slack_revocation_during_membership_stops_before_rpc(self):
        bridge, transport = self.slack(count=0)
        client = SlackClient()
        client.after_members = lambda: setattr(transport, "allowed", False)
        await bridge.handle_event(slack_event(), client, account_id="Tfixture", event_id="Ev-member-revoke")
        self.assertEqual(len(client.member_calls), 1)
        self.assertEqual((client.posts, transport.requests), ([], []))

    async def test_slack_simultaneous_events_keep_their_own_sdk_client(self):
        bridge, transport = self.slack(count=0)
        clients = [SlackClient(), SlackClient()]
        clients[0].members = ["BOT", "Uactor", "Ufirst"]
        clients[1].members = ["BOT", "Uactor", "Usecond"]
        entered = asyncio.Event()
        release = asyncio.Event()
        original = transport.send

        async def send(request, **callbacks):
            if request.context.event_id == "Ev-first":
                entered.set()
                await release.wait()
            return await original(request, **callbacks)
        transport.send = send
        first = asyncio.create_task(bridge.handle_event(slack_event(), clients[0], account_id="Tfixture", event_id="Ev-first"))
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            await bridge.handle_event(slack_event(), clients[1], account_id="Tfixture", event_id="Ev-second")
        finally:
            release.set()
            await first
        by_id = {request.context.event_id: request.context.audience_ids for request in transport.requests}
        self.assertEqual(by_id["Ev-first"], ("Uactor", "Ufirst"))
        self.assertEqual(by_id["Ev-second"], ("Uactor", "Usecond"))
        self.assertTrue(all(client.posts for client in clients))
        self.assertEqual(bridge._event_clients, {})

    def discord(self, *, members=(7, 8, 999), intent=True, parent_id=None):
        transport = Transport()
        bridge = DiscordBridge("synthetic-token", allowed_guilds=["22"], listen_channels=[str(parent_id) if parent_id is not None else "33"],
            transport=transport, binding_id="binding-discord", members_intent=intent)
        channel = DiscordChannel(parent_id=parent_id)
        guild = RestGuild(channel, members)
        bridge._client = DiscordClient(guild)
        async def rest(context, path, *, params=None):
            await bridge.authorize_context(context)
            result = await guild.rest(context, path, params=params)
            await bridge.authorize_context(context)
            return result
        bridge._audience_rest = rest
        return bridge, transport, channel, guild

    async def test_discord_uses_fresh_rest_roles_channel_and_members_before_rpc(self):
        bridge, transport, channel, guild = self.discord(members=(7, 8, 9, 999))
        channel.visible = {"7", "8", "999"}
        context = bridge._bridge_context(discord_message(channel, 50))
        await bridge.send_message("current", context=context)
        delivered = transport.requests[0].context
        self.assertEqual(delivered.audience_ids, ("7", "8"))
        self.assertEqual(delivered.conversation_kind, "channel")
        self.assertTrue(delivered.audience_complete)
        self.assertIsNotNone(delivered.audience_verified_at)
        self.assertEqual(bridge._client.calls, [])  # No cache/SDK filtered role view.
        self.assertEqual(guild.calls[:3], [("/guilds/22", None), ("/channels/33", None), ("/guilds/22/members", {"limit": 1000})])
        self.assertGreaterEqual(len(guild.calls), 10)

    async def test_discord_missing_actor_bot_overflow_intent_and_incomplete_roles_are_denied(self):
        for case in ("unknown-actor", "overflow", "intent-off", "missing-bot", "hidden-bot", "permissions-unavailable", "unknown-role", "unknown-overwrite-role"):
            with self.subTest(case=case):
                bridge, transport, channel, guild = self.discord(
                    members=tuple(range(1, 1002)) if case == "overflow" else (7, 8, 999),
                    intent=case != "intent-off")
                if case == "unknown-actor":
                    channel.visible = {"8", "999"}
                if case == "permissions-unavailable":
                    guild.raw_guild["roles"][0].pop("permissions")
                if case == "missing-bot":
                    guild.members_to_fetch.remove(999)
                if case == "hidden-bot":
                    channel.visible = {"7", "8"}
                if case == "unknown-role":
                    guild.role_assignments["8"] = ["404"]
                if case == "unknown-overwrite-role":
                    guild.raw_channel["permission_overwrites"] = [{"id": "404", "type": 0, "allow": "1024", "deny": "0"}]
                context = bridge._bridge_context(discord_message(channel, 50))
                with self.assertRaises(PermissionError):
                    await bridge.send_message("current", context=context)
                self.assertEqual(transport.requests, [])
                if case == "intent-off":
                    self.assertEqual(guild.calls, [])

    async def test_discord_revocation_while_fetching_members_stops_before_rpc(self):
        bridge, transport, channel, guild = self.discord()
        guild.on_member = lambda: setattr(transport, "allowed", False)
        context = bridge._bridge_context(discord_message(channel, 50))
        with self.assertRaises(PermissionError):
            await bridge.send_message("current", context=context)
        self.assertEqual(transport.requests, [])

    async def test_discord_public_threads_include_parent_viewers_not_only_subscribers(self):
        for thread_type, parent_type in ((10, 5), (11, 0), (11, 15), (11, 16)):
            with self.subTest(thread=thread_type, parent=parent_type):
                bridge, transport, channel, guild = self.discord(parent_id=30)
                guild.raw_channel["type"] = thread_type
                guild.raw_parent["type"] = parent_type
                guild.joined = [7, 999]  # 8 can still read a public thread.
                context = bridge._bridge_context(discord_message(channel, 50))
                await bridge.send_message("shared thread", context=context)
                self.assertEqual(transport.requests[0].context.audience_ids, ("7", "8"))
                self.assertFalse(any(path.endswith("thread-members") for path, _ in guild.calls))
                await bridge.send_text_chunk(channel, "same thread")
                self.assertEqual(channel.posts, ["same thread"])
                self.assertEqual(context.thread_id, "33")
                self.assertEqual(context.conversation_id, "30")

    async def test_discord_parent_authorization_and_rest_thread_relationship_are_independent(self):
        for case in ("authorized", "parent-not-authorized", "foreign-thread-parent"):
            with self.subTest(case=case):
                bridge, transport, channel, guild = self.discord(parent_id=30)
                bridge.listen_channels = {"30", "31"}
                original = transport.authorize_context
                async def authorize(value):
                    return await original(value) and value.conversation_id in {"30"}
                transport.authorize_context = authorize
                if case == "parent-not-authorized":
                    channel.parent_id = 31
                elif case == "foreign-thread-parent":
                    guild.raw_channel["parent_id"] = "31"
                message = discord_message(channel, 50)
                context = bridge._bridge_context(message)
                interaction = SimpleNamespace(user=message.author, channel=channel, channel_id=33,
                                              guild=message.guild, guild_id=22)
                self.assertEqual(bridge._interaction_scope(interaction),
                                 ("7", "31" if case == "parent-not-authorized" else "30", "22", False))
                if case == "authorized":
                    await bridge.send_message("thread", context=context)
                    self.assertEqual((context.conversation_id, context.thread_id), ("30", "33"))
                    self.assertTrue(any(path == "/channels/30" for path, _ in guild.calls))
                    self.assertEqual(len(transport.requests), 1)
                    parent = DiscordChannel("30")
                    with self.assertRaises(PermissionError):
                        await bridge.send_text_chunk(parent, "private response must stay in thread")
                    with self.assertRaises(PermissionError):
                        await bridge._history(discord_message(parent, 50), context)
                    self.assertEqual((parent.posts, parent.calls), ([], []))
                else:
                    with self.assertRaises(PermissionError):
                        await bridge.send_message("must not dispatch", context=context)
                    self.assertEqual(transport.requests, [])
                    if case == "parent-not-authorized":
                        self.assertEqual(guild.calls, [])

    async def test_discord_private_thread_includes_joined_managers_admin_and_owner(self):
        bridge, transport, channel, guild = self.discord(parent_id=30, members=(7, 8, 9, 10, 11, 12, 999))
        guild.raw_channel["type"] = 12
        guild.raw_guild["owner_id"] = "11"
        guild.role_assignments = {"9": ["40"], "10": ["41"], "12": ["40"]}
        guild.raw_parent["permission_overwrites"] = [{"id": "12", "type": 1, "allow": "0", "deny": "1024"}]
        context = bridge._bridge_context(discord_message(channel, 50))
        await bridge.send_message("private thread", context=context)
        # Parent viewer 8 is not invited; manager 12 cannot view the parent.
        self.assertEqual(transport.requests[0].context.audience_ids, ("10", "11", "7", "9"))
        self.assertTrue(all(params["with_member"] == "true" and params["limit"] == 100
                            for path, params in guild.calls if path.endswith("thread-members")))
        self.assertEqual(context.conversation_kind, "thread")

    async def test_discord_private_thread_can_use_existing_manager_bot_without_joining(self):
        bridge, transport, channel, guild = self.discord(parent_id=30)
        guild.raw_channel["type"] = 12
        guild.joined = [7]
        guild.role_assignments["999"] = ["40"]
        await bridge.send_message("already authorized manager", context=bridge._bridge_context(discord_message(channel, 50)))
        self.assertEqual(transport.requests[0].context.audience_ids, ("7",))

    async def test_discord_private_or_unverifiable_thread_never_falls_back_to_parent(self):
        cases = ("actor-unjoined", "bot-unjoined", "bot-cannot-send", "foreign-member", "duplicate-member",
                 "missing-expanded-member", "changed-member-roles", "unknown-role", "archived", "locked", "metadata-missing",
                 "foreign-parent-guild", "foreign-parent-id", "wrong-parent-type", "mismatched-thread-context")
        for case in cases:
            with self.subTest(case=case):
                bridge, transport, channel, guild = self.discord(parent_id=30)
                guild.raw_channel["type"] = 12
                if case == "actor-unjoined":
                    guild.joined = [999]
                elif case == "bot-unjoined":
                    guild.joined = [7]
                elif case == "bot-cannot-send":
                    guild.raw_parent["permission_overwrites"] = [{"id": "999", "type": 1, "allow": "0", "deny": str(1 << 38)}]
                elif case in ("foreign-member", "duplicate-member", "missing-expanded-member", "changed-member-roles"):
                    members = [{"id": "33", "user_id": "7", "member": guild.member(7)},
                               {"id": "33", "user_id": "999", "member": guild.member(999)}]
                    if case == "foreign-member":
                        members[0]["id"] = "34"
                    elif case == "duplicate-member":
                        members.append(copy.deepcopy(members[0]))
                    elif case == "missing-expanded-member":
                        members[0].pop("member")
                    else:
                        members[0]["member"]["roles"] = ["40"]
                    guild.thread_pages = {None: members}
                elif case == "unknown-role":
                    guild.role_assignments["8"] = ["404"]
                elif case in ("archived", "locked"):
                    guild.raw_channel["thread_metadata"][case] = True
                elif case == "metadata-missing":
                    guild.raw_channel.pop("thread_metadata")
                elif case == "foreign-parent-guild":
                    guild.raw_parent["guild_id"] = "23"
                elif case == "foreign-parent-id":
                    guild.raw_channel["parent_id"] = "31"
                elif case == "wrong-parent-type":
                    guild.raw_parent["type"] = 15
                context = bridge._bridge_context(discord_message(channel, 50))
                if case == "mismatched-thread-context":
                    context = replace(context, thread_id="34")
                with self.assertRaises(PermissionError):
                    await bridge.send_message("private", context=context)
                self.assertEqual((transport.requests, channel.posts), ([], []))

    async def test_discord_exact_member_cap_requires_empty_overflow_probe(self):
        bridge, transport, channel, guild = self.discord(members=tuple(range(1, 1001)))
        await bridge.send_message("at cap", context=bridge._bridge_context(discord_message(channel, 50)))
        context = transport.requests[0].context
        self.assertEqual(len(context.audience_ids), 999)
        self.assertIn(("/guilds/22/members", {"limit": 1, "after": "1000"}), guild.calls)

    async def test_discord_exact_private_thread_cap_is_paginated_and_probed(self):
        bridge, transport, channel, guild = self.discord(parent_id=30, members=tuple(range(1, 1001)))
        guild.raw_channel["type"] = 12
        guild.joined = list(range(1, 1001))
        await bridge.send_message("at thread cap", context=bridge._bridge_context(discord_message(channel, 50)))
        self.assertEqual(len(transport.requests[0].context.audience_ids), 999)
        pages = [params for path, params in guild.calls if path.endswith("thread-members")]
        self.assertIn({"with_member": "true", "limit": 1, "after": "1000"}, pages)
        self.assertTrue(any(params.get("after") == "100" and params["limit"] == 100 for params in pages))

    async def test_discord_roles_or_overwrites_changing_during_scan_deny_before_rpc(self):
        for case in ("roles", "assigned-roles", "parent-overwrites", "thread-topology", "thread-roster", "guild-members"):
            with self.subTest(case=case):
                bridge, transport, channel, guild = self.discord(parent_id=30)
                guild.raw_channel["type"] = 12
                changed = False
                def mutate(path, params):
                    nonlocal changed
                    if changed:
                        return
                    if path == "/guilds/22/members" and case != "thread-roster":
                        changed = True
                        if case == "roles":
                            guild.raw_guild["roles"][0]["permissions"] = str(1024 | 2048)
                        elif case == "assigned-roles":
                            guild.role_assignments["8"] = ["40"]
                        elif case == "guild-members":
                            guild.members_to_fetch.append(10)
                        elif case == "parent-overwrites":
                            guild.raw_parent["permission_overwrites"].append({"id": "8", "type": 1, "allow": "0", "deny": "1024"})
                        else:
                            guild.raw_channel["parent_id"] = "31"
                    elif path.endswith("thread-members") and case == "thread-roster":
                        changed = True
                        guild.joined.append(8)
                guild.after_rest = mutate
                with self.assertRaises(PermissionError):
                    await bridge.send_message("must not dispatch", context=bridge._bridge_context(discord_message(channel, 50)))
                self.assertEqual(transport.requests, [])

    async def test_discord_private_membership_changes_before_egress_are_reauthorized(self):
        for remove_actor in (True, False):
            with self.subTest(remove_actor=remove_actor):
                bridge, transport, channel, guild = self.discord(parent_id=30)
                guild.raw_channel["type"] = 12
                transport.delivery_policy = lambda value: "8" not in value.audience_ids
                transport.before_reply = lambda: guild.joined.remove(7) if remove_actor else guild.joined.append(8)
                with self.assertRaises(PermissionError):
                    await bridge.send_message("current", context=bridge._bridge_context(discord_message(channel, 50)))
                self.assertEqual(len(transport.requests), 1)
                self.assertEqual(channel.posts, [])

    async def test_discord_gateway_mention_gate_uses_authorized_parent_and_exact_thread_route(self):
        for mention, listened in ((False, "30"), (True, "30"), (True, "33"), (True, "31")):
            with self.subTest(mention=mention, listened=listened):
                bridge, transport, channel, guild = self.discord(parent_id=30)
                bridge.listen_channels = {listened}
                bridge.context_messages = 0
                bridge._live = False
                client = bridge._client
                message = discord_message(channel, 50, text="<@999> thread question")
                message.attachments = []
                message.mentions = [client.user] if mention else []
                callbacks = {}
                client.event = lambda fn: callbacks.setdefault(fn.__name__, fn)
                async def start(token):
                    await callbacks["on_message"](message)
                client.start = start
                class Tree:
                    def command(self, **kwargs):
                        return lambda fn: fn
                sdk = SimpleNamespace(
                    Intents=SimpleNamespace(default=lambda: SimpleNamespace()), Client=lambda **kwargs: client,
                    DMChannel=type("DMChannel", (), {}), app_commands=SimpleNamespace(CommandTree=lambda client: Tree()),
                )
                with patch.dict("sys.modules", {"discord": sdk}):
                    await bridge._run()
                expected = mention and listened == "30"
                self.assertEqual(bool(transport.requests), expected)
                self.assertEqual(bool(channel.posts), expected)
                if expected:
                    context = transport.requests[0].context
                    self.assertEqual((context.actor_id, context.conversation_id, context.thread_id), ("7", "30", "33"))
                else:
                    self.assertEqual(guild.calls, [])

    async def test_discord_audience_rest_is_fixed_bounded_and_revocable(self):
        class Content:
            def __init__(self, raw, after_read=None):
                self.raw, self.position, self.after_read = raw, 0, after_read
            async def read(self, length):
                chunk = self.raw[self.position:self.position + min(length, 3)]
                self.position += len(chunk)
                if self.after_read:
                    self.after_read()
                return chunk
        class Response:
            def __init__(self, raw, status=200, after_read=None):
                self.status, self.content = status, Content(raw, after_read)
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
        class Session:
            closed = False
            def __init__(self, response):
                self.response, self.calls = response, []
            def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return self.response
            async def close(self):
                self.closed = True
        for case in ("success", "revoked", "redirect", "bad-json"):
            with self.subTest(case=case):
                bridge, transport, channel, _ = self.discord()
                raw = json.dumps({"id": "22"}).encode() if case != "bad-json" else b"not json"
                response = Response(raw, status=302 if case == "redirect" else 200,
                    after_read=(lambda: setattr(transport, "allowed", False)) if case == "revoked" else None)
                session = Session(response)
                bridge._audience_session = session
                context = bridge._bridge_context(discord_message(channel, 50))
                method = DiscordBridge._audience_rest
                if case == "success":
                    self.assertEqual(await method(bridge, context, "/guilds/22"), {"id": "22"})
                    self.assertGreater(len(transport.checked), 4)
                else:
                    with self.assertRaises((PermissionError, ValueError)):
                        await method(bridge, context, "/guilds/22")
                self.assertEqual(session.calls[0][0], "https://discord.com/api/v10/guilds/22")
                self.assertIs(session.calls[0][1]["allow_redirects"], False)
                self.assertEqual(len(session.calls), 1)
                bridge._client = None
                await bridge.stop()
                self.assertTrue(session.closed)

    async def test_discord_new_member_during_model_is_attested_and_denied_before_output(self):
        bridge, transport, channel, guild = self.discord()
        context = bridge._bridge_context(discord_message(channel, 50))
        transport.delivery_policy = lambda value: "10" not in value.audience_ids
        transport.before_reply = lambda: guild.members_to_fetch.append(10)
        with self.assertRaises(PermissionError):
            await bridge.send_message("current", context=context)
        self.assertEqual(len(transport.requests), 1)
        self.assertNotIn("10", transport.deliveries[-1].audience_ids)
        self.assertGreater(sum(path == "/guilds/22/members" for path, _ in guild.calls), 2)
        with self.assertRaises(PermissionError):
            await bridge.send_text_chunk(channel, "must not escape")
        self.assertEqual(channel.posts, [])

    async def test_discord_each_outward_chunk_refreshes_rest_audience(self):
        bridge, transport, channel, guild = self.discord()
        context = bridge._bridge_context(discord_message(channel, 50))
        await bridge.send_message("current", context=context)
        transport.delivery_policy = lambda value: "10" not in value.audience_ids
        await bridge.send_text_chunk(channel, "first permitted chunk")
        first_reads = len(guild.calls)
        guild.members_to_fetch.append(10)
        with self.assertRaises(PermissionError):
            await bridge.send_text_chunk(channel, "second forbidden chunk")
        self.assertGreater(len(guild.calls), first_reads)
        self.assertEqual(channel.posts, ["first permitted chunk"])

    async def test_discord_direct_requires_actual_sdk_dm_and_recipient(self):
        class DMChannel(DiscordChannel):
            recipient = SimpleNamespace(id=7)
        class GroupChannel(DiscordChannel):
            pass
        with patch.dict("sys.modules", {"discord": SimpleNamespace(DMChannel=DMChannel, GroupChannel=GroupChannel)}):
            bridge, transport, _, guild = self.discord()
            bridge.allowed_users = {"7"}
            channel = DMChannel()
            guild.channel = channel
            context = bridge._bridge_context(discord_message(channel, 50, guild=None))
            await bridge.send_message("direct", context=context)
            self.assertEqual(context.conversation_kind, "direct")
            delivered = transport.requests[0].context
            self.assertEqual((delivered.audience_ids, delivered.audience_complete), (("7",), True))
            self.assertTrue(all(kind == "direct" for kind, _ in bridge._client.calls))
            guild.channel = GroupChannel()
            wrong = bridge._bridge_context(discord_message(guild.channel, 51, guild=None))
            with self.assertRaises(PermissionError):
                await bridge.send_message("group is not direct", context=wrong)
            self.assertEqual(len(transport.requests), 1)

    def telegram(self, *, chat_type="private", chat_id=7, actor_id=7):
        transport = Transport()
        bridge = TelegramBridge("synthetic-token", allowed_users=["7"], allowed_chats=[-33],
            transport=transport, binding_id="binding-telegram", live=False)

        class Bot:
            id = 999
            def __init__(self):
                self.calls = []
                self.chat_type = chat_type
                self.chat_id = chat_id
                self.after_chat = None

            async def get_chat(self, *, chat_id):
                self.calls.append(chat_id)
                if self.after_chat:
                    self.after_chat()
                return SimpleNamespace(id=self.chat_id, type=self.chat_type)
        bot = Bot()
        posts = []

        async def reply_text(text, **kwargs):
            posts.append(text)
        message = SimpleNamespace(from_user=SimpleNamespace(id=actor_id),
            chat=SimpleNamespace(id=chat_id, type=chat_type), message_id=50,
            message_thread_id=None, reply_to_message=None, get_bot=lambda: bot,
            reply_text=reply_text)
        return bridge, transport, bot, message, posts

    async def test_telegram_private_uses_sdk_chat_actor_and_fresh_api_before_rpc_and_egress(self):
        bridge, transport, bot, message, posts = self.telegram()
        context = bridge._bridge_context(message)
        self.assertEqual(context.conversation_kind, "direct")
        await bridge.send_message("private question", context=context)
        self.assertEqual(transport.requests[0].context.audience_ids, ("7",))
        self.assertTrue(transport.requests[0].context.audience_complete)
        await bridge.send_text_chunk(message, "first")
        first_reads = len(bot.calls)
        self.assertGreaterEqual(first_reads, 3)
        self.assertEqual(bot.calls, [7] * first_reads)
        bot.chat_type = "group"
        with self.assertRaises(PermissionError):
            await bridge.send_text_chunk(message, "must not escape")
        self.assertGreater(len(bot.calls), first_reads)
        self.assertEqual(posts, ["first"])

    async def test_telegram_wrong_private_actor_or_bot_fails_closed(self):
        bridge, transport, bot, message, _ = self.telegram(actor_id=8)
        with self.assertRaises(PermissionError):
            bridge._bridge_context(message)
        bridge, transport, bot, message, _ = self.telegram()
        context = bridge._bridge_context(message)
        bot.chat_id = 8
        with self.assertRaises(PermissionError):
            await bridge.send_message("wrong participant", context=context)
        self.assertEqual(transport.requests, [])
        bot.chat_id = 7
        bot.id = 1000
        with self.assertRaises(PermissionError):
            await bridge.send_message("wrong bot account", context=context)
        self.assertEqual(transport.requests, [])

    async def test_telegram_group_audience_remains_incomplete_without_enumeration(self):
        bridge, transport, bot, message, _ = self.telegram(chat_type="supergroup", chat_id=-33)
        context = bridge._bridge_context(message)
        self.assertEqual(context.conversation_kind, "group")
        with self.assertRaises(PermissionError):
            await bridge.send_message("group question", context=context)
        self.assertEqual((bot.calls, transport.requests), ([], []))

    async def test_telegram_revocation_during_api_read_stops_before_rpc(self):
        bridge, transport, bot, message, _ = self.telegram()
        context = bridge._bridge_context(message)
        bot.after_chat = lambda: setattr(transport, "allowed", False)
        with self.assertRaises(PermissionError):
            await bridge.send_message("revoked", context=context)
        self.assertEqual((bot.calls, transport.requests), ([7], []))

    def test_members_intent_is_opt_in_and_validated(self):
        bridge = DiscordBridge("synthetic-token", transport=Transport(), binding_id="binding-discord")
        self.assertIs(bridge.members_intent, False)
        for value in ("true", 1, None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                DiscordBridge("synthetic-token", transport=Transport(), binding_id="binding-discord",
                              members_intent=value)

    def test_context_limits_reject_bool_out_of_range_and_non_integer(self):
        for value in (-1, 101, True, 1.0, "20"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.slack(count=value)
