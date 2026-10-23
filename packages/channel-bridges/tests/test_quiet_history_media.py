"""Provider fixtures and request-local IPC; no provider account or model IO."""
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import time

import pytest

from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import (
    BridgeAttachment, BridgeCapabilities, BridgeContext, BridgeEvent,
    BridgeHistoryMessage, BridgeMessage, BridgePart, BridgeReply,
)
from openagent_channel_bridges.history import history_size_bytes
from openagent_channel_bridges.slack import SlackBridge, _SlackDownloadOutcome
from openagent_channel_bridges.discord import DiscordBridge
from openagent_channel_bridges.wire import ArtifactStore, WireError, to_wire


class Host:
    def __init__(self, *, history_media=True, history_max_files=16):
        self.allowed = True
        self.history_media = history_media
        self.history_max_files = history_max_files
        self.requests, self.inputs, self.speech = [], [], []
        self.revoke_on_send = False

    async def authorize_context(self, context):
        return self.allowed

    async def authorize_delivery(self, context):
        return self.allowed

    async def start(self):
        return BridgeCapabilities(input_media=("file", "image", "video", "voice", "audio"),
                                  history_media=self.history_media, history_max_files=self.history_max_files)

    async def stop(self):
        pass

    async def transcribe(self, context, attachment):
        self.speech.append((context.actor_id, attachment.provider_attachment_id))
        return "A synthetic historical voice note."

    async def send(self, request, *, on_event=None):
        self.requests.append(request)
        self.inputs = [part.attachment for record in request.history for part in record.parts
                       if part.attachment is not None]
        for attachment in self.inputs:
            assert Path(attachment.local_path).read_bytes() == b"fixture"
        if on_event:
            for event in (BridgeEvent("status", "private tool arguments"),
                          BridgeEvent("text", "intermediate narration"),
                          BridgeEvent("compaction", '{"phase":"running"}')):
                await on_event(event)
        if self.revoke_on_send:
            self.allowed = False
        return BridgeReply(parts=(BridgePart(text="Final answer; literal narration remains legitimate text."),))


class Capture(BaseBridge):
    name = "slack"

    def __init__(self, host, **kwargs):
        super().__init__(transport=host, binding_id="binding", **kwargs)
        self.posts, self.progress = [], []

    async def _run(self):
        pass

    async def send_text_chunk(self, target, chunk):
        self.posts.append(chunk)

    async def post_status(self, target, text):
        self.progress.append(text)
        return "status"

    async def post_compaction_notice(self, target):
        self.progress.append("compaction")


def context():
    return BridgeContext("binding", "slack", "T", "alice", "C", "50.0",
        conversation_kind="channel", audience_ids=("alice", "bob"),
        audience_complete=True, audience_verified_at=time.time())


@pytest.mark.asyncio
async def test_quiet_has_one_initial_ack_and_unchanged_final_no_tool_delta_or_compaction():
    bridge = Capture(Host(), delivery_mode="quiet")
    await bridge.dispatch_turn("target", "hint", "work", context=context())
    assert bridge.posts == ["Received. I’ll reply when finished.",
                           "Final answer; literal narration remains legitimate text."]
    assert bridge.progress == []


@pytest.mark.asyncio
async def test_quiet_acknowledgement_is_explicit_host_text_without_locale_inference():
    exact = "Ricevuto. Verifico le segnalazioni e risponderò qui al termine."
    bridge = Capture(Host(), delivery_mode="quiet", acknowledgement_text=exact)
    await bridge.dispatch_turn("target", "hint", "work", context=context())
    assert bridge.posts[0] == exact and len(bridge.posts) == 2
    for invalid in ("", " ", "two\nlines", "è" * 257):
        with pytest.raises(ValueError):
            Capture(Host(), delivery_mode="quiet", acknowledgement_text=invalid)


@pytest.mark.asyncio
async def test_quiet_does_not_publish_result_after_revocation_and_live_remains_opt_in():
    host = Host(); host.revoke_on_send = True
    bridge = Capture(host, delivery_mode="quiet")
    await bridge.dispatch_turn("target", "hint", "work", context=context())
    assert bridge.posts == ["Received. I’ll reply when finished."]
    live = Capture(Host(), delivery_mode="live")
    await live.dispatch_turn("target", "hint", "work", context=context())
    assert live.progress and "Received. I’ll reply when finished." not in live.posts


class SlackClient:
    def __init__(self, files):
        self.files, self.posts = files, []
        self.members = ["BOT", "alice", "bob"]

    async def auth_test(self):
        return {"ok": True, "team_id": "T", "user_id": "BOT"}

    async def conversations_members(self, **kwargs):
        return {"ok": True, "members": self.members, "response_metadata": {}}

    async def conversations_history(self, **kwargs):
        return {"messages": [
            {"ts": "10.0", "user": "bob", "text": "", "files": self.files},
            {"ts": "11.0", "user": "bob", "text": "wrong channel", "channel": "OTHER", "files": self.files},
            {"ts": "12.0", "user": "bob", "text": "wrong thread", "thread_ts": "9.0", "files": self.files},
        ]}

    async def chat_postMessage(self, **kwargs):
        self.posts.append(kwargs)


def media_files():
    return [{"id": identifier, "name": name, "mimetype": mime, "size": 7,
             "url_private_download": "https://files.slack.com/" + identifier}
            for identifier, name, mime in (("Fimage", "image.png", "image/png"),
                ("Fvideo", "video.mp4", "video/mp4"), ("Fvoice", "voice.ogg", "audio/ogg"),
                ("Ffile", "report.txt", "text/plain"))]


def slack(host, client, downloads):
    bridge = SlackBridge("not-a-token", allowed_users=["alice"], listen_channels=["C"],
                         transport=host, binding_id="binding", delivery_mode="quiet")
    bridge._bot_user_id = "BOT"
    async def download(url, directory, filename, **kwargs):
        assert host.allowed and kwargs["max_bytes"] > 0
        downloads.append(url)
        path = Path(directory) / filename
        path.write_bytes(b"fixture")
        return _SlackDownloadOutcome(str(path), size_bytes=7)
    bridge._download_file = download
    return bridge


@pytest.mark.asyncio
async def test_slack_historical_media_only_message_roundtrips_and_cleans_request_files():
    host = Host(); client = SlackClient(media_files()); downloads = []
    bridge = slack(host, client, downloads)
    await bridge.handle_event({"type": "app_mention", "channel": "C", "user": "alice",
        "text": "<@BOT> inspect today's reports", "ts": "50.0"}, client,
        account_id="T", event_id="50.0")
    assert len(downloads) == 4 and len(host.requests) == 1
    request = host.requests[0]
    assert len(request.history) == 1 and request.history[0].actor_id == "bob"
    assert {value.kind for value in host.inputs} == {"image", "video", "voice", "file"}
    assert host.speech == [("alice", "Fvoice")]
    assert any("historical voice note" in (part.text or "") for part in request.history[0].parts)
    assert all(not Path(value.local_path).exists() for value in host.inputs)
    assert len(client.posts) == 2 and all(value["channel"] == "C" for value in client.posts)
    assert all("thread_ts" not in value for value in client.posts)
    assert history_size_bytes(request.history) <= 65536


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["unchanged", "revoked", "audience-change"])
async def test_historical_speech_refreshes_proof_after_43_second_transcription(monkeypatch, change):
    # A host may require an SDK audience proof no older than 30 seconds.
    # Match a first 43-second STT followed by a second file at t+52 seconds,
    # without waiting or relaxing the host's ordinary freshness policy.
    clock = [10000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    files = [{"id": f"voice-{i}", "name": f"voice-{i}.ogg", "mimetype": "audio/ogg",
              "size": 7, "url_private_download": f"https://files.slack.com/voice-{i}"}
             for i in range(2)]
    client = SlackClient(files)

    class FreshSpeechHost(Host):
        async def transcribe(self, context, attachment):
            if not self.allowed or clock[0] - context.audience_verified_at > 30:
                raise PermissionError("speech requires a current authorized audience proof")
            self.speech.append((context.actor_id, attachment.provider_attachment_id))
            clock[0] += 43 if len(self.speech) == 1 else 1
            if len(self.speech) == 1:
                if change == "revoked":
                    self.allowed = False
                elif change == "audience-change":
                    client.members.append("new-recipient")
            return "A synthetic historical voice note."

    host = FreshSpeechHost(); downloads = []
    bridge = slack(host, client, downloads)
    original_download = bridge._download_file
    async def download(*args, **kwargs):
        if downloads:
            clock[0] += 9
        return await original_download(*args, **kwargs)
    bridge._download_file = download
    await bridge.handle_event({"type": "app_mention", "channel": "C", "user": "alice",
        "text": "<@BOT> inspect both historical voice notes", "ts": "50.0"}, client,
        account_id="T", event_id="50.0")
    if change == "unchanged":
        assert len(host.speech) == 2 and len(host.requests) == 1
        assert len(host.inputs) == 2 and len(client.posts) == 2
        assert all(not Path(value.local_path).exists() for value in host.inputs)
    else:
        assert len(host.speech) == 1 and host.requests == []
        assert len(client.posts) == 1  # authorized initial ack only


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["transcribe", "synthesize"])
@pytest.mark.parametrize("change", ["unchanged", "revoked", "audience-change"])
async def test_speech_callbacks_receive_fresh_proof_and_revalidate_after_long_call(tmp_path, monkeypatch, operation, change):
    clock = [10000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    path = tmp_path / "voice.ogg"; path.write_bytes(b"original audio")
    media = BridgeAttachment("voice", path.name, "audio/ogg", path.stat().st_size, local_path=str(path))

    class FreshSpeechHost(Host):
        async def start(self):
            return BridgeCapabilities(input_media=("voice",), output_media=("voice",))

        async def record_speech(self, context):
            assert clock[0] - context.audience_verified_at <= 30
            self.speech.append(context)
            clock[0] += 43
            if change == "revoked":
                self.allowed = False

        async def transcribe(self, context, attachment):
            await self.record_speech(context)
            return "Transcript."

        async def synthesize(self, context, text):
            await self.record_speech(context)
            return media

    class FreshProvider(Capture):
        async def _delivery_context(self, context):
            members = ("alice", "bob", "new-recipient") if change == "audience-change" and host.speech else ("alice", "bob")
            return replace(context, audience_ids=members, audience_verified_at=clock[0])

    host = FreshSpeechHost()
    bridge = FreshProvider(host)
    original = context()
    clock[0] += 52
    async def invoke():
        if operation == "transcribe":
            return await bridge.transcribe_with_fallback(str(path), context=original, attachment=media)
        return await bridge._synthesize("Say this.", context=original)
    if change == "unchanged":
        assert await invoke() == ("Transcript." if operation == "transcribe" else media)
    else:
        with pytest.raises(PermissionError): await invoke()
    assert len(host.speech) == 1
    assert path.read_bytes() == b"original audio"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["normal", "missing-cursor", "repeated-cursor", "revoked", "other-channel", "trigger-duplicate"])
async def test_slack_latest_200_uses_two_scoped_pages_and_preserves_oldest_media(mode):
    host = Host(history_max_files=64)
    pages = [[{"ts": str(i) + ".0", "user": "bob", "channel": "C", "text": "report"}
              for i in range(high, low, -1)] for high, low in ((200, 100), (100, 0))]
    pages[1][-1]["files"] = [media_files()[-1]]
    if mode == "other-channel":
        pages[1][-1]["channel"] = "OTHER"
    if mode == "trigger-duplicate":
        pages[0][0]["ts"] = "500.0"
        pages[1][0]["ts"] = "199.0"

    class Pages(SlackClient):
        def __init__(self):
            super().__init__([])
            self.calls = []

        async def conversations_history(self, **kwargs):
            self.calls.append(kwargs)
            assert kwargs["channel"] == "C" and kwargs["latest"] == "500.0"
            assert kwargs["inclusive"] is False and kwargs["limit"] == 100
            index = len(self.calls) - 1
            assert index < 2
            if index:
                assert kwargs["cursor"] == "page-two"
            if mode == "revoked": host.allowed = False
            cursor = "" if mode == "missing-cursor" else "page-two" if index == 0 or mode == "repeated-cursor" else ""
            return {"messages": pages[index], "has_more": bool(cursor) or mode == "missing-cursor",
                    "response_metadata": {"next_cursor": cursor}}

    client = Pages(); downloads = []
    bridge = slack(host, client, downloads)
    bridge.context_messages = 200
    await bridge.handle_event({"type": "app_mention", "channel": "C", "user": "alice",
        "text": "<@BOT> inspect the bounded report window", "ts": "500.0"}, client,
        account_id="T", event_id="500.0")
    if mode in ("missing-cursor", "repeated-cursor", "revoked"):
        assert host.requests == [] and downloads == []
        assert len(client.posts) == (1 if mode == "revoked" else 2)
        return
    assert len(client.calls) == 2 and len(host.requests) == 1
    records = host.requests[0].history
    assert len(records) == {"normal": 200, "other-channel": 199, "trigger-duplicate": 198}[mode]
    assert len({record.event_id for record in records}) == len(records)
    assert all(record.event_id != "500.0" for record in records)
    assert len(downloads) == (0 if mode == "other-channel" else 1)
    if mode != "other-channel":
        assert records[0].event_id == "1.0" and len(host.inputs) == 1
    assert history_size_bytes(records) <= 65536


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["old-host", "file-count", "byte-budget", "audience-change"])
async def test_history_does_not_fetch_unsupported_over_budget_or_changed_audience(tmp_path, mode):
    host = Host(history_media=mode != "old-host"); client = SlackClient(media_files()); downloads = []
    bridge = slack(host, client, downloads)
    ctx = context(); bridge._event_clients[bridge._event_key(ctx)] = client
    existing = [{"size_bytes": 1}] * 16 if mode == "file-count" else []
    if mode == "byte-budget":
        existing = [{"size_bytes": 64 << 20}]
    if mode == "audience-change":
        client.members.append("new-recipient")
        with pytest.raises(PermissionError):
            await bridge._history(client, ctx, is_dm=False, trigger_ts="50.0", media_directory=str(tmp_path))
    else:
        result = await bridge._history(client, ctx, is_dm=False, trigger_ts="50.0",
                                      media_directory=str(tmp_path), current_attachments=existing)
        notices = result[0].omitted_attachments
        assert len(notices) == 4 and {value.reason for value in notices} == {
            "unsupported" if mode == "old-host" else "limit"}
        assert not any(part.attachment for part in result[0].parts)
    assert downloads == []


def test_history_uses_the_same_ipc_reader_and_request_expiry_as_current_media(tmp_path):
    path = tmp_path / "image.png"; path.write_bytes(b"fixture")
    attachment = BridgeAttachment("image", path.name, "image/png", 7,
                                  local_path=str(path), provider_attachment_id="Fimage")
    message = BridgeMessage(context(), (BridgePart(text="inspect"),),
        history=(BridgeHistoryMessage("10.0", "bob", (BridgePart(attachment=attachment),)),))
    store = ArtifactStore(); store.begin("request")
    try:
        dto = to_wire(message, store, "request")
        value = dto["history"][0]["parts"][0]["attachment"]
        assert "local_path" not in value and "url" not in value and value["sha256"]
        params = {"reader_ref": value["reader_ref"], "offset": 0, "length": 65536}
        assert store.read("request", params)["eof"] is True
        store.end("request")
        with pytest.raises(WireError):
            store.read("request", params)
        assert path.read_bytes() == b"fixture"  # unowned provider input was not deleted
    finally:
        store.close()


@pytest.mark.asyncio
async def test_discord_history_keeps_media_only_voice_and_exact_native_thread(tmp_path):
    host = Host()
    class Bridge(DiscordBridge):
        async def _delivery_context(self, ctx):
            return ctx  # Provider audience fixtures are covered separately.
    bridge = Bridge("not-a-token", allowed_users=["7"], allowed_guilds=["22"],
        listen_channels=["33"], transport=host, binding_id="binding")
    class Channel:
        id = 44
        def history(self, **kwargs):
            async def values():
                for channel in (self, SimpleNamespace(id=99)):
                    yield SimpleNamespace(id=10, channel=channel, guild=SimpleNamespace(id=22),
                        author=SimpleNamespace(id=8), content="", created_at=None,
                        attachments=[SimpleNamespace(id=123, filename="voice.ogg", content_type="audio/ogg", size=7)])
            return values()
    current = SimpleNamespace(id=50, channel=Channel(), guild=SimpleNamespace(id=22))
    ctx = BridgeContext("binding", "discord", "22", "7", "33", "50", thread_id="44",
        conversation_kind="thread", audience_ids=("7", "8"), audience_complete=True,
        audience_verified_at=time.time())
    reads = []
    async def download(attachment, path, *, context, channel_id, max_bytes):
        reads.append((attachment.id, channel_id, context.actor_id))
        path.write_bytes(b"fixture")
    bridge._download_attachment = download
    rows = await bridge._history(current, ctx, media_directory=str(tmp_path))
    assert reads == [(123, "44", "7")] and len(rows) == 1
    assert rows[0].actor_id == "8" and rows[0].parts[0].attachment.kind == "voice"
    assert host.speech == [("7", "123")]


def test_quiet_configuration_rejects_ambiguous_legacy_and_explicit_modes():
    with pytest.raises(ValueError):
        Capture(Host(), live=True, delivery_mode="quiet")
    with pytest.raises(ValueError):
        Capture(Host(), delivery_mode="guess-the-last-paragraph")
    with pytest.raises(ValueError):
        BridgeCapabilities(history_media="true")
    for invalid in (True, 15, 65, "64"):
        with pytest.raises(ValueError):
            BridgeCapabilities(history_media=True, history_max_files=invalid)
    with pytest.raises(ValueError):
        BridgeCapabilities(history_max_files=64)


@pytest.mark.asyncio
@pytest.mark.parametrize("advertised,count,available", [(16, 38, 16), (64, 38, 38), (64, 65, 64)])
async def test_history_count_opt_in_keeps_byte_limit_and_explicit_omissions(tmp_path, advertised, count, available):
    from openagent_channel_bridges.history_media import prepare_history_media
    host = Host(history_max_files=advertised)
    bridge = Capture(host)
    rows = tuple(BridgeHistoryMessage(str(index), "bob", (BridgePart(attachment=BridgeAttachment(
        "image", f"image-{index}.png", "image/png", 7, provider_attachment_id=f"F{index}")),))
        for index in range(count))
    reads = []
    async def load(record, attachment, remaining):
        assert 0 < remaining <= 32 << 20
        path = tmp_path / attachment.filename
        path.write_bytes(b"fixture")
        reads.append(path)
        return replace(attachment, local_path=str(path))
    result = await prepare_history_media(bridge, rows, context(), load)
    assert len(reads) == available
    assert sum(part.attachment is not None for row in result for part in row.parts) == available
    assert sum(len(row.omitted_attachments) for row in result) == count - available
    blocked = await prepare_history_media(bridge, rows, context(), load,
        current_attachments=({"size_bytes": 64 << 20},))
    assert not any(part.attachment for row in blocked for part in row.parts)
    assert len(reads) == available  # Raising the count never raises 64 MiB.


@pytest.mark.asyncio
async def test_history_38_provider_fixture_records_keep_all_media_in_the_selected_window():
    host = Host(history_max_files=64)
    files = [{**media_files()[index % 4], "id": f"F{index}"} for index in range(38)]
    client = SlackClient(files)
    async def history(**kwargs):
        return {"messages": [{"ts": str(10 + index) + ".0", "user": "bob", "text": "",
            "files": [file]} for index, file in enumerate(files)]}
    client.conversations_history = history
    downloads = []
    bridge = slack(host, client, downloads)
    bridge.context_messages = 100
    await bridge.handle_event({"type": "app_mention", "channel": "C", "user": "alice",
        "text": "<@BOT> inspect the reports", "ts": "100.0"}, client,
        account_id="T", event_id="100.0")
    assert len(downloads) == len(host.inputs) == 38
    assert len(host.requests[0].history) == 38
    assert not any(row.omitted_attachments for row in host.requests[0].history)
    assert all(not Path(value.local_path).exists() for value in host.inputs)
    assert len(client.posts) == 2


@pytest.mark.asyncio
async def test_quiet_ack_precedes_blocked_history_without_creating_an_agent_run():
    import asyncio
    host = Host(); client = SlackClient([]); bridge = slack(host, client, [])
    entered, release = asyncio.Event(), asyncio.Event()
    async def history(**kwargs):
        entered.set(); await release.wait()
        return {"messages": []}
    client.conversations_history = history
    task = asyncio.create_task(bridge.handle_event({"type": "app_mention", "channel": "C", "user": "alice",
        "text": "<@BOT> inspect reports", "ts": "50.0"}, client, account_id="T", event_id="event-secret"))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        assert [p["text"] for p in client.posts] == ["Received. I’ll reply when finished."]
        assert host.requests == []
    finally:
        release.set(); await asyncio.wait_for(task, 2)
    assert len(client.posts) == 2 and len(host.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["normal", "revoke", "audience-change", "initial-deny"])
async def test_38_streamed_history_files_bound_provider_calls_not_chunks_and_revoke_safely(mode, capsys):
    from openagent_channel_bridges.media import MEDIA_CHUNK_BYTES
    size = 8 * MEDIA_CHUNK_BYTES
    host = Host(history_max_files=64)
    if mode == "initial-deny": host.allowed = False
    files = [{"id": f"F{i}", "name": f"image-{i}.png", "mimetype": "image/png", "size": size,
        "url_private_download": f"https://files.slack.com/F{i}"} for i in range(38)]
    class Client(SlackClient):
        def __init__(self):
            super().__init__(files); self.scans = 0
        async def conversations_members(self, **kwargs):
            self.scans += 1
            return await super().conversations_members(**kwargs)
        async def conversations_history(self, **kwargs):
            return {"messages": [{"ts": str(10+i)+".0", "user": "bob", "text": "", "files": [file]}
                                 for i, file in enumerate(files)]}
    client = Client(); reads = []
    class Content:
        async def iter_chunked(self, limit):
            assert limit == MEDIA_CHUNK_BYTES
            for index in range(8):
                reads.append(index)
                if len(reads) == 1:
                    if mode == "revoke": host.allowed = False
                    if mode == "audience-change": client.members.append("new-recipient")
                yield b"x" * MEDIA_CHUNK_BYTES
    class Response:
        status = 200
        headers = {"Content-Length": str(size)}
        content = Content()
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
    class HTTP:
        def get(self, *args, **kwargs): return Response()
    bridge = SlackBridge("not-a-token", allowed_users=["alice"], listen_channels=["C"], context_messages=100,
        transport=host, binding_id="binding", delivery_mode="quiet")
    bridge._bot_user_id = "BOT"
    async def session(): return HTTP()
    bridge._audio_session = session
    # Admission rejection remains a hard exception before any provider output.
    event = {"type": "app_mention", "channel": "C", "user": "alice", "text": "<@BOT> inspect", "ts": "100.0"}
    if mode == "initial-deny":
        with pytest.raises(PermissionError):
            await bridge.handle_event(event, client, account_id="T", event_id="100.0")
        assert client.posts == [] and reads == [] and host.requests == []
        return
    await bridge.handle_event(event, client, account_id="T", event_id="100.0")
    if mode == "normal":
        assert len(reads) == 38 * 8 and len(host.requests[0].history) == len(host.inputs) == 38
        assert client.scans <= 8 * 38 + 30  # O(files), not O(chunks).
        assert len(client.posts) == 2
        assert all(not Path(value.local_path).exists() for value in host.inputs)
    else:
        assert host.requests == [] and len(client.posts) == 1
        assert len(reads) == (1 if mode == "revoke" else 8)
        assert '"code":"authorization_denied"' in capsys.readouterr().err


@pytest.mark.asyncio
async def test_requested_history_failure_has_one_authorized_final_and_no_empty_run(capsys):
    host = Host(); client = SlackClient([]); bridge = slack(host, client, [])
    async def unavailable(**kwargs): raise RuntimeError("PRIVATE_URL_TOKEN_CONTENT_MUST_NOT_ESCAPE")
    client.conversations_history = unavailable
    await bridge.handle_event({"type": "app_mention", "channel": "C", "user": "alice",
        "text": "<@BOT> inspect", "ts": "50.0"}, client, account_id="T", event_id="private-event")
    assert len(client.posts) == 2 and not host.requests
    assert "No agent task was started" in client.posts[-1]["text"]
    assert "PRIVATE_URL_TOKEN_CONTENT" not in str(client.posts) + capsys.readouterr().err
    bridge.context_messages = 0
    await bridge.handle_event({"type": "app_mention", "channel": "C", "user": "alice",
        "text": "<@BOT> ordinary message", "ts": "51.0"}, client, account_id="T", event_id="next-event")
    assert len(host.requests) == 1 and len(client.posts) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("revoked", [False, True])
async def test_transcription_timeout_keeps_original_audio_only_with_fresh_authorization(tmp_path, revoked):
    from openagent_channel_bridges.base import VOICE_FALLBACK
    host = Host()
    async def transcribe(*args):
        if revoked: host.allowed = False
        raise TimeoutError("PRIVATE_PROVIDER_ENDPOINT")
    host.transcribe = transcribe
    bridge = Capture(host)
    path = tmp_path / "voice.ogg"; path.write_bytes(b"original audio")
    media = BridgeAttachment("voice", path.name, "audio/ogg", path.stat().st_size, local_path=str(path))
    if revoked:
        with pytest.raises(PermissionError):
            await bridge.transcribe_with_fallback(str(path), context=context(), attachment=media)
    else:
        assert await bridge.transcribe_with_fallback(str(path), context=context(), attachment=media) == VOICE_FALLBACK
    assert path.read_bytes() == b"original audio"


def test_diagnostic_lines_have_closed_schema_and_no_identifiers_or_content(capsys):
    import hashlib, json
    from openagent_channel_bridges.diagnostics import emit_diagnostic, PREFIX
    ctx = context()
    emit_diagnostic(ctx, "history", "completed", files=38, bytes=52968872, transcriptions=4)
    line = capsys.readouterr().err
    assert line.startswith(PREFIX) and len(line.encode()) <= 1024
    value = json.loads(line[len(PREFIX):])
    assert set(value) == {"schema_version", "provider", "stage", "code", "event_sha256", "counters"}
    assert value["counters"] == {"files": 38, "bytes": 52968872, "transcriptions": 4}
    expected = hashlib.sha256(b"oa-channel-diagnostic/v1\n" + json.dumps(list(ctx.deduplication_key),
        ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    assert value["event_sha256"] == expected
    assert "alice" not in line and "binding" not in line and "50.0" not in line
    for field, bad in (("files", True), ("files", 65), ("bytes", (64<<20)+1), ("transcriptions", -1)):
        with pytest.raises(ValueError): emit_diagnostic(ctx, "history", "failed", **{field: bad})
    for stage, code in (("PRIVATE_PATH", "failed"), ("history", "SECRET")):
        with pytest.raises(ValueError): emit_diagnostic(ctx, stage, code)


@pytest.mark.asyncio
async def test_slow_transfer_renews_only_request_local_provider_proof_and_never_caches_host_grants(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("openagent_channel_bridges.base.time.monotonic", lambda: clock[0])
    class Bridge(Capture):
        calls = 0
        async def _delivery_context(self, value):
            self.calls += 1
            return value
    host = Host(); bridge = Bridge(host)
    proof = await bridge._prepare_delivery_context(context())
    authorize = bridge._transfer_authorizer(proof)
    for _ in range(100): await authorize()
    assert bridge.calls == 1
    clock[0] += 11
    await authorize()
    assert bridge.calls == 2
    host.allowed = False
    with pytest.raises(PermissionError): await authorize()
    assert bridge.calls == 2  # A fresh host denial is immediate, never cached.
