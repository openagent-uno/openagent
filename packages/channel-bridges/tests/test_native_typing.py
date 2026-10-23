"""Actual async lifecycle/provider calls; no real accounts or model requests."""
import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest
from openagent_channel_bridges.contracts import BridgeContext, BridgeReply, BridgePart, BridgeCapabilities
from openagent_channel_bridges.discord import DiscordBridge
from openagent_channel_bridges.slack import SlackBridge, _SlackTarget
from openagent_channel_bridges.whatsapp import WhatsAppBridge


def context(provider="discord", **kw):
    return BridgeContext("binding", provider, "account", "alice", "42", "event",
                         conversation_kind="direct", **kw)


class Host:
    def __init__(self):
        self.allowed = True
        self.entered, self.finish = asyncio.Event(), asyncio.Event()
        self.authorizations = 0

    async def authorize_context(self, ctx):
        self.authorizations += 1
        return self.allowed

    async def authorize_delivery(self, ctx):
        return self.allowed

    async def start(self): return BridgeCapabilities()
    async def stop(self): pass

    async def send(self, message, *, on_event=None):
        self.entered.set()
        await self.finish.wait()
        return BridgeReply(parts=(BridgePart(text="Final"),))


class Channel:
    id = 42
    def __init__(self): self.pulses = 0; self.posts = []
    async def trigger_typing(self): self.pulses += 1
    async def send(self, text, **kwargs): self.posts.append(text)


@pytest.mark.asyncio
async def test_quiet_discord_types_during_blocked_run_without_progress_posts():
    host, channel = Host(), Channel()
    bridge = DiscordBridge("token", transport=host, binding_id="binding")
    # Provider target/audience admission is exercised separately below. This
    # fixture uses a direct authenticated context and no SDK network client.
    async def direct(ctx): return ctx
    bridge._delivery_context = direct
    task = asyncio.create_task(bridge.dispatch_turn(channel, "session", "work", context=context()))
    try:
        await asyncio.wait_for(host.entered.wait(), 1)
        for _ in range(10):
            if channel.pulses: break
            await asyncio.sleep(0)
        assert channel.pulses == 1
        assert channel.posts == ["Received. I’ll reply when finished."]
    finally:
        host.finish.set()
        await task
    assert channel.posts[-1] == "Final"
    assert not [t for t in asyncio.all_tasks() if t.get_name() == "channel-native-typing"]


@pytest.mark.asyncio
async def test_lifecycle_revocation_stop_timeout_and_rate_limit():
    from openagent_channel_bridges.typing import ProcessingIndicator, TypingSpec, TypingRateLimited
    calls = []
    allowed = True
    async def auth():
        if not allowed: raise PermissionError()
    async def pulse(): calls.append("pulse")
    async def clear(): calls.append("clear")
    spec = TypingSpec(pulse, interval=.002, clear=clear)
    indicator = ProcessingIndicator(spec, auth)
    await indicator.begin(); await asyncio.sleep(.008)
    allowed = False
    await asyncio.sleep(.008)
    count = len(calls)
    await indicator.end()
    assert count >= 1 and calls == ["pulse"] * count
    assert indicator.task.done()
    # An indefinitely waiting provider call is cancelled and joined on end.
    gate = asyncio.Event()
    async def blocked(): await gate.wait(); calls.append("late")
    indicator = ProcessingIndicator(TypingSpec(blocked), lambda: asyncio.sleep(0))
    await indicator.begin(); await indicator.end()
    gate.set(); await asyncio.sleep(0)
    assert "late" not in calls and indicator.task.done()
    # Rate-limits longer than the bounded budget terminate without retry.
    async def limited(): calls.append("429"); raise TypingRateLimited(300)
    indicator = ProcessingIndicator(TypingSpec(limited), lambda: asyncio.sleep(0))
    await indicator.begin(); await asyncio.sleep(0); await indicator.end()
    assert calls.count("429") == 1
    gate.clear()
    indicator = ProcessingIndicator(TypingSpec(blocked), lambda: asyncio.sleep(0))
    indicator.request_timeout = .002
    await indicator.begin(); await asyncio.sleep(.008)
    assert indicator.task.done()
    await indicator.end()


@pytest.mark.asyncio
async def test_slack_existing_thread_status_and_clear_without_changing_placement():
    calls = []
    async def status(**kw): calls.append(kw); return {"ok": True}
    target = _SlackTarget(SimpleNamespace(assistant_threads_setStatus=status), "42", "alice", "10.2")
    bridge = SlackBridge("bot", "app", transport=Host(), binding_id="binding")
    ctx = context("slack", thread_id="10.2")
    spec = bridge.native_typing(target, ctx)
    await spec.pulse(); await spec.clear()
    assert calls == [{"channel_id": "42", "thread_ts": "10.2", "status": "is typing…"},
                     {"channel_id": "42", "thread_ts": "10.2", "status": ""}]
    assert bridge.native_typing(_SlackTarget(target.client, "42", "alice"), context("slack")) is None
    with pytest.raises(PermissionError): bridge.native_typing(target, replace(ctx, thread_id="other"))
    async def forbidden(**kw): return {"ok": False, "error": "missing_scope"}
    target.client.assistant_threads_setStatus = forbidden
    with pytest.raises(PermissionError): await bridge.native_typing(target, ctx).pulse()


@pytest.mark.asyncio
async def test_whatsapp_uses_documented_async_green_method_and_old_clients_unsupported():
    calls = []
    async def send(chat, **kw): calls.append((chat, kw)); return SimpleNamespace(code=200)
    bridge = WhatsAppBridge("instance", "token", transport=Host(), binding_id="binding")
    ctx = BridgeContext("binding", "whatsapp", "instance", "alice", "alice@c.us", "event", conversation_kind="direct")
    assert bridge.native_typing("alice@c.us", ctx) is None
    bridge._greenapi = SimpleNamespace(serviceMethods=SimpleNamespace(sendTypingAsync=send))
    spec = bridge.native_typing("alice@c.us", ctx)
    await spec.pulse()
    assert spec.interval == 7 and calls == [("alice@c.us", {"typingTime": 10000})]
    with pytest.raises(PermissionError): bridge.native_typing("wrong", ctx)
    bridge.allowed_users = {"other"}
    with pytest.raises(PermissionError): await spec.pulse()
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_nested_intake_dispatch_reuses_indicator_and_stop_joins_all_tasks():
    host, channel = Host(), Channel()
    bridge = DiscordBridge("token", transport=host, binding_id="binding")
    async def direct(ctx): return ctx
    bridge._delivery_context = direct
    ctx = context()
    first = await bridge.begin_processing(channel, ctx)
    nested = await bridge.begin_processing(channel, ctx)
    assert nested is first
    await asyncio.sleep(.001)
    assert channel.pulses == 1
    await bridge.end_processing(nested)
    assert not first.closed
    with pytest.raises(PermissionError):
        await bridge.begin_processing(channel, replace(ctx, actor_id="other"))
    await bridge.stop()
    assert first.closed and first.task.done() and not bridge._typing_leases
    pulses = channel.pulses
    await asyncio.sleep(.002)
    assert channel.pulses == pulses


@pytest.mark.asyncio
async def test_dispatch_cancellation_joins_indicator_and_never_posts_final():
    host, channel = Host(), Channel()
    bridge = DiscordBridge("token", transport=host, binding_id="binding")
    async def direct(ctx): return ctx
    bridge._delivery_context = direct
    task = asyncio.create_task(bridge.dispatch_turn(channel, "session", "work", context=context()))
    await asyncio.wait_for(host.entered.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert not bridge._typing_leases
    assert "Final" not in channel.posts
    assert not [t for t in asyncio.all_tasks() if t.get_name() == "channel-native-typing"]


@pytest.mark.asyncio
async def test_new_audience_or_host_revocation_denies_typing_before_any_provider_call():
    host, channel = Host(), Channel()
    bridge = DiscordBridge("token", transport=host, binding_id="binding")
    async def changed(ctx): return replace(ctx, actor_id="mallory")
    bridge._delivery_context = changed
    indicator = await bridge.begin_processing(channel, context())
    await asyncio.sleep(.002)
    assert channel.pulses == 0 and indicator.task.done()
    await bridge.end_processing(indicator)
    host.allowed = False
    indicator = await bridge.begin_processing(channel, context())
    await asyncio.sleep(.002)
    assert channel.pulses == 0 and indicator.task.done()
    await bridge.end_processing(indicator)


@pytest.mark.asyncio
async def test_concurrent_slack_events_do_not_clear_each_others_active_status():
    calls = []
    async def status(**kw): calls.append(kw["status"]); return {"ok": True}
    bridge = SlackBridge("bot", transport=Host(), binding_id="binding")
    async def direct(ctx): return ctx
    bridge._delivery_context = direct
    target = _SlackTarget(SimpleNamespace(assistant_threads_setStatus=status), "42", "alice", "10.2")
    ctx = context("slack", thread_id="10.2")
    first = await bridge.begin_processing(target, ctx)
    second = await bridge.begin_processing(target, replace(ctx, event_id="second"))
    await asyncio.sleep(.002)
    await bridge.end_processing(first)
    assert calls == ["is typing…", "is typing…"]
    await bridge.end_processing(second)
    assert calls == ["is typing…", "is typing…", ""]
    assert not bridge._typing_leases


@pytest.mark.asyncio
async def test_whatsapp_native_indicator_covers_actual_voice_preflight_and_cancellation(tmp_path):
    path = tmp_path / "voice" / "fixture.ogg"
    path.parent.mkdir(); path.write_bytes(b"synthetic")
    host, seen, transcribing = Host(), [], asyncio.Event()
    bridge = WhatsAppBridge("instance", "token", transport=host, binding_id="binding")
    async def typing(chat, **kw): seen.append((chat, kw)); return SimpleNamespace(code=200)
    bridge._greenapi = SimpleNamespace(serviceMethods=SimpleNamespace(sendTypingAsync=typing))
    async def download(*args, **kw): return str(path)
    async def speech(*args, **kw):
        transcribing.set()
        await asyncio.Event().wait()
    bridge._download_or_notify, bridge.transcribe_with_fallback = download, speech
    body = {"idMessage": "voice", "senderData": {"chatId": "alice@c.us"},
            "messageData": {"typeMessage": "voiceMessage", "fileMessageData": {
                "downloadUrl": "https://example.invalid/synthetic", "fileName": "fixture.ogg"}}}
    task = asyncio.create_task(bridge._handle(body))
    await asyncio.wait_for(transcribing.wait(), 1)
    await asyncio.sleep(.002)
    assert seen == [("alice@c.us", {"typingTime": 10000})]
    assert not host.entered.is_set()  # no run needed to show preflight typing
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert not bridge._typing_leases
    assert not [t for t in asyncio.all_tasks() if t.get_name() == "channel-native-typing"]


@pytest.mark.asyncio
async def test_rate_limit_retries_are_finite_and_provider_forbidden_never_retries():
    from openagent_channel_bridges.typing import ProcessingIndicator, TypingSpec, TypingRateLimited
    calls = []
    async def limited(): calls.append("429"); raise TypingRateLimited(.001)
    indicator = ProcessingIndicator(TypingSpec(limited, interval=.001), lambda: asyncio.sleep(0))
    await indicator.begin(); await asyncio.sleep(.02)
    assert indicator.task.done() and calls == ["429"] * 3
    await indicator.end()
    async def forbidden(): calls.append("403"); raise PermissionError()
    indicator = ProcessingIndicator(TypingSpec(forbidden, interval=.001), lambda: asyncio.sleep(0))
    await indicator.begin(); await asyncio.sleep(.004)
    assert indicator.task.done() and calls.count("403") == 1
    await indicator.end()


@pytest.mark.asyncio
async def test_clear_rechecks_other_turns_after_slow_authorization():
    from openagent_channel_bridges.typing import ProcessingIndicator, TypingSpec
    clearing, release = asyncio.Event(), asyncio.Event()
    calls, other_active = [], False
    async def auth():
        if clearing.is_set(): await release.wait()
    async def pulse(): calls.append("pulse")
    async def clear(): calls.append("clear")
    indicator = ProcessingIndicator(TypingSpec(pulse, clear=clear), auth)
    await indicator.begin(); await asyncio.sleep(.002)
    clearing.set()
    ending = asyncio.create_task(indicator.end(clear=lambda: not other_active))
    await asyncio.sleep(.002)
    other_active = True
    release.set(); await ending
    assert calls == ["pulse"]


@pytest.mark.asyncio
async def test_whatsapp_presence_does_not_reclassify_inbound_or_admit_group_typing():
    calls, contexts = [], []
    host = Host()
    bridge = WhatsAppBridge("instance", "token", transport=host, binding_id="binding")
    async def native(chat, **kw): calls.append(chat); return SimpleNamespace(code=200)
    bridge._greenapi = SimpleNamespace(serviceMethods=SimpleNamespace(sendTypingAsync=native))
    async def dispatch(*args, context, **kwargs):
        contexts.append(context)
        await asyncio.sleep(.002)
    bridge.dispatch_turn = dispatch
    for chat in ("alice@c.us", "group@g.us"):
        body = {"idMessage": chat, "senderData": {"chatId": chat, "sender": "alice@c.us"},
                "messageData": {"typeMessage": "textMessage", "textMessageData": {"textMessage": "synthetic"}}}
        await bridge._handle(body)
    assert [ctx.conversation_kind for ctx in contexts] == ["unknown", "unknown"]
    assert calls == ["alice@c.us"]
    assert bridge.native_typing("alice@c.us", replace(contexts[0], conversation_kind="group")) is None


WA_ADMISSION_CASES = [
    ("personal-fallback", "alice@c.us", None, ["alice"], True, True, True, None),
    ("personal-explicit", "alice@c.us", "alice@c.us", ["alice"], True, True, True, None),
    ("personal-denied", "alice@c.us", "alice@c.us", ["bob"], True, False, False, None),
    ("group-member", "group@g.us", "alice@c.us", ["alice"], True, True, False, None),
    ("group-route-allowlist", "group@g.us", "alice@c.us", ["group"], True, False, False, None),
    ("mismatched-sender-admitted", "alice@c.us", "bob@c.us", ["bob"], True, True, False, None),
    ("mismatched-sender-denied", "alice@c.us", "bob@c.us", ["alice"], True, False, False, None),
    ("group-missing-sender", "group@g.us", None, ["group"], True, False, False, None),
    ("host-denied", "alice@c.us", "alice@c.us", ["alice"], False, False, False, "PermissionError"),
    ("group-unrestricted", "group@g.us", "alice@c.us", None, True, True, False, None),
]


async def observe_whatsapp_admission(bridge_type, case):
    """Shared differential harness also run against the actual public SDK12."""
    name, chat, sender, allowlist, host_allowed, *_ = case
    native, dispatched, original_authorizations = [], [], []
    host = Host(); host.allowed = host_allowed
    authorize = host.authorize_context
    async def record(ctx):
        if ctx.conversation_kind == "unknown":
            original_authorizations.append((ctx.actor_id, ctx.conversation_id, ctx.conversation_kind))
        return await authorize(ctx)
    host.authorize_context = record
    bridge = bridge_type("instance", "token", allowed_users=allowlist,
                         transport=host, binding_id="binding")
    async def pulse(chat_id, **kw): native.append(chat_id); return SimpleNamespace(code=200)
    bridge._greenapi = SimpleNamespace(serviceMethods=SimpleNamespace(sendTypingAsync=pulse))
    async def dispatch(*args, context, **kwargs):
        dispatched.append((context.actor_id, context.conversation_id, context.conversation_kind))
        await asyncio.sleep(.002)
    bridge.dispatch_turn = dispatch
    sender_data = {"chatId": chat}
    if sender is not None: sender_data["sender"] = sender
    body = {"idMessage": name, "senderData": sender_data, "messageData": {
        "typeMessage": "textMessage", "textMessageData": {"textMessage": "synthetic"}}}
    error = None
    try:
        await bridge._handle(body)
    except Exception as exc:
        error = type(exc).__name__
    return {"case": name, "dispatched": dispatched,
            "originalAuthorizations": original_authorizations, "error": error, "native": native}


@pytest.mark.asyncio
@pytest.mark.parametrize("case", WA_ADMISSION_CASES, ids=[row[0] for row in WA_ADMISSION_CASES])
async def test_whatsapp_original_allowlist_identity_admission_unchanged(case):
    result = await observe_whatsapp_admission(WhatsAppBridge, case)
    _, chat, sender, _, host_allowed, admitted, typing, error = case
    assert bool(result["dispatched"]) is admitted
    assert bool(result["native"]) is typing
    assert result["error"] == error
    if admitted:
        expected_actor = (sender or chat).replace("@c.us", "").replace("@g.us", "")
        assert result["dispatched"] == [(expected_actor, chat, "unknown")]
        assert result["originalAuthorizations"] == [(expected_actor, chat, "unknown")]
