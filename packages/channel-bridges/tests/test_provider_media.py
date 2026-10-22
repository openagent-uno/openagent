"""Pure staging helpers: no engine, store, voice backend or provider calls."""
import os
from pathlib import PurePosixPath
import unittest
from unittest.mock import patch

from openagent_channel_bridges.media import (
    attachment_limit_bytes, is_audio_file, safe_attachment_filename,
    safe_attachment_staging_name,
)


class ProviderMediaTests(unittest.TestCase):
    def test_attachment_defaults_and_explicit_instance_environment(self):
        self.assertEqual(attachment_limit_bytes(environment={}), 64 * 1024 * 1024)
        self.assertEqual(attachment_limit_bytes(direction="output", environment={}), 256 * 1024 * 1024)
        # A host-owned empty mapping must not inherit a different process cap.
        with patch.dict(os.environ, {"OPENAGENT_MAX_INBOUND_ATTACHMENT_MB": "2"}):
            self.assertEqual(attachment_limit_bytes(), 2 * 1024 * 1024)
            self.assertEqual(attachment_limit_bytes(environment={}), 64 * 1024 * 1024)

    def test_attachment_zero_negative_invalid_and_output_settings(self):
        key = "OPENAGENT_MAX_INBOUND_ATTACHMENT_MB"
        for value in ("0", "-1"):
            with self.subTest(value=value):
                self.assertEqual(attachment_limit_bytes(environment={key: value}), 0)
        for value in ("", "not-a-size"):
            with self.subTest(value=value):
                self.assertEqual(attachment_limit_bytes(environment={key: value}), 64 * 1024 * 1024)
        self.assertEqual(attachment_limit_bytes(direction="output", environment={"OPENAGENT_MAX_ATTACHMENT_MB": "7"}), 7 * 1024 * 1024)

    def test_filename_strips_paths_and_control_characters(self):
        self.assertEqual(safe_attachment_filename("../../reports/quarter.pdf"), "quarter.pdf")
        self.assertEqual(safe_attachment_filename("C:\\temp\\report\x00\n.pdf"), "report.pdf")
        for value in (None, "", "..", "../..", "/"):
            with self.subTest(value=value):
                self.assertEqual(safe_attachment_filename(value), "attachment")
        self.assertEqual(safe_attachment_filename("", fallback="../../safe.txt"), "safe.txt")

    def test_unicode_filename_is_240_bytes_not_240_characters(self):
        for value in ("界" * 200 + ".pdf", "🙂" * 200 + ".png", "é" * 240 + ".txt"):
            with self.subTest(suffix=value[-4:]):
                result = safe_attachment_filename(value)
                self.assertLessEqual(len(result.encode("utf-8")), 240)
                self.assertTrue(result.endswith(value[-4:]))
                self.assertEqual(PurePosixPath(result).name, result)
                self.assertNotIn("\ufffd", result)

    def test_combined_staging_name_is_bounded_and_preserves_suffix(self):
        result = safe_attachment_staging_name("../" + "識" * 200, "C:\\tmp\\" + "🙂" * 200 + ".pdf")
        self.assertLessEqual(len(result.encode("utf-8")), 240)
        self.assertTrue(result.endswith(".pdf"))
        self.assertNotIn("/", result)
        self.assertNotIn("\\", result)
        self.assertEqual(safe_attachment_staging_name("provider-id", "report.pdf"), "provider-id-report.pdf")

    def test_audio_mime_and_extensions_without_voice_backend(self):
        self.assertTrue(is_audio_file("recording.MP3"))
        self.assertTrue(is_audio_file(None, "audio/ogg"))
        self.assertTrue(is_audio_file("recording.bin", "audio/wav"))
        self.assertFalse(is_audio_file("recording.pdf", "application/pdf"))
        self.assertFalse(is_audio_file(None))


# Provider IO fixtures use no sockets, credentials, speech model or engine.
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
from unittest.mock import AsyncMock

from openagent_channel_bridges.base import VOICE_FALLBACK
from openagent_channel_bridges.contracts import BridgeCapabilities, BridgeContext, BridgeReply
from openagent_channel_bridges.discord import DiscordBridge
from openagent_channel_bridges.slack import SlackBridge, _SlackTarget
from openagent_channel_bridges.media import (
    MEDIA_CHUNK_BYTES, MediaTransferTooLarge, authorized_file_chunks,
    media_file_snapshot, write_authorized_download,
)


class _Transport:
    def __init__(self):
        self.allowed = True
        self.audience_allowed = True
        self.authorizations = 0
        self.delivery_checks = 0
        self.requests = []
        self.transcriptions = []
        self.transcript = "spoken words"
        self.on_transcribe = None

    async def start(self):
        return BridgeCapabilities(input_media=("image", "file", "voice", "audio", "video"))

    async def stop(self):
        pass

    async def authorize_context(self, context):
        self.authorizations += 1
        return self.allowed

    async def authorize_delivery(self, context):
        self.delivery_checks += 1
        return self.allowed and self.audience_allowed and context.audience_complete

    async def transcribe(self, context, attachment):
        self.transcriptions.append((context, attachment, Path(attachment.local_path).read_bytes()))
        if self.on_transcribe:
            self.on_transcribe()
        return self.transcript

    async def send(self, request, *, on_event=None):
        self.requests.append((request, tuple(Path(p.attachment.local_path).read_bytes()
                                           for p in request.parts if p.attachment)))
        return BridgeReply()


class _MediaBridgeMixin:
    async def _delivery_context(self, context):
        # This fixture supplies provider-attested audience independently of IO;
        # real SDK membership refresh is covered in test_provider_context.py.
        audience = (context.actor_id, "new-reader") if getattr(self.transport, "new_member", False) else (context.actor_id,)
        return replace(context, audience_ids=tuple(sorted(audience)), audience_complete=True,
                       audience_verified_at=time.time())

    async def dispatch_turn(self, target, session_id, text, **kwargs):
        self.last_target = target
        self.last_input = kwargs
        return await self.send_message(text, session_id, attachments=kwargs.get("attachments"),
                                       context=kwargs["context"], history=kwargs.get("history"),
                                       input_was_voice=kwargs.get("voice_detected", False))


class _Slack(_MediaBridgeMixin, SlackBridge):
    pass


class _Discord(_MediaBridgeMixin, DiscordBridge):
    pass


class _Content:
    def __init__(self, chunks=(), *, on_chunk=None):
        self.chunks = list(chunks)
        self.on_chunk = on_chunk
        self.reads = 0
        self.raw = b"".join(self.chunks)

    async def iter_chunked(self, size):
        for index, chunk in enumerate(self.chunks):
            if len(chunk) > size:
                raise AssertionError("fixture chunk exceeds negotiated size")
            self.reads += 1
            if self.on_chunk:
                self.on_chunk(index)
            yield chunk

    async def read(self, size):
        self.reads += 1
        result, self.raw = self.raw[:size], self.raw[size:]
        return result


class _Response:
    def __init__(self, *, chunks=(), status=200, headers=None, on_chunk=None):
        self.status = status
        self.headers = headers or {}
        self.content = _Content(chunks, on_chunk=on_chunk)
        self.upload = None
        self.uploaded = bytearray()
        self.on_write = None

    async def __aenter__(self):
        if self.upload is not None:
            if hasattr(self.upload, "__aiter__"):
                async for chunk in self.upload:
                    self.uploaded.extend(chunk)
                    if self.on_write:
                        self.on_write(chunk)
            else:
                # aiohttp public multipart serialization; no requests are sent.
                response = self
                class Writer:
                    async def write(self, chunk):
                        response.uploaded.extend(chunk)
                        if response.on_write:
                            response.on_write(chunk)
                await self.upload().write(Writer())
        return self

    async def __aexit__(self, *exc):
        return False


class _Session:
    def __init__(self, response):
        self.response = response
        self.calls = []
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.closed = True

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.response

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        self.response.upload = kwargs["data"]
        return self.response


class _SlackClient:
    def __init__(self):
        self.slots = []
        self.completions = []
        self.posts = []

    async def files_getUploadURLExternal(self, **kwargs):
        self.slots.append(kwargs)
        return {"ok": True, "file_id": "F1", "upload_url": "https://files.slack.com/upload/v1/example"}

    async def files_completeUploadExternal(self, **kwargs):
        self.completions.append(kwargs)
        return {"ok": True}

    async def chat_postMessage(self, **kwargs):
        self.posts.append(kwargs)
        return {"ok": True}


class ProviderMediaIOTests(unittest.IsolatedAsyncioTestCase):
    def context(self, provider="slack", *, conversation="C1", thread=None, kind="channel"):
        return BridgeContext("binding", provider, "T1", "U1", conversation, "E1",
                             thread_id=thread, conversation_kind=kind)

    def slack(self, transport=None):
        bridge = _Slack("fixture-bot-token", transport=transport or _Transport(), binding_id="binding",
                        allowed_users=["U1"], listen_channels=["C1"], context_messages=0, live=False)
        bridge._account_id, bridge._bot_user_id = "T1", "BOT"
        return bridge

    def discord(self, transport=None):
        return _Discord("fixture-bot-token", transport=transport or _Transport(), binding_id="binding",
                        allowed_users=["7"], allowed_guilds=["22"], listen_channels=["33"],
                        context_messages=0, live=False)

    async def test_chunk_download_revocation_discards_only_owned_partial_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "media.bin"
            allowed, checks = True, 0
            async def authorize():
                nonlocal checks
                checks += 1
                if not allowed:
                    raise PermissionError("revoked")
            def revoke(index):
                nonlocal allowed
                if index == 1:
                    allowed = False
            content = _Content([b"first", b"second"], on_chunk=revoke)
            with self.assertRaises(PermissionError):
                await write_authorized_download(content, path, authorize, limit=100)
            self.assertFalse(path.exists())
            self.assertGreaterEqual(checks, 5)
            path.write_bytes(b"existing")
            allowed = True
            with self.assertRaises(FileExistsError):
                await write_authorized_download(_Content([b"new"]), path, authorize)
            self.assertEqual(path.read_bytes(), b"existing")

    async def test_chunk_caps_and_upload_file_replacement_fail_closed(self):
        async def authorize():
            return None
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.bin"
            with self.assertRaises(MediaTransferTooLarge):
                await write_authorized_download(_Content([b"123", b"456"]), path, authorize, limit=5)
            self.assertFalse(path.exists())
            path.write_bytes(b"first")
            snapshot = media_file_snapshot(path)
            replacement = Path(tmp) / "replacement"
            replacement.write_bytes(b"other")
            replacement.replace(path)
            with self.assertRaises(ValueError):
                async for _ in authorized_file_chunks(path, authorize, snapshot=snapshot):
                    self.fail("replacement bytes must never be yielded")

    async def test_slack_download_requires_audience_before_io_and_each_chunk(self):
        bridge = self.slack()
        response = _Response(chunks=[b"one", b"two"], headers={"Content-Length": "6"})
        session = _Session(response)
        bridge._audio_session = AsyncMock(return_value=session)
        context = self.context()
        with tempfile.TemporaryDirectory() as tmp:
            bridge.transport.audience_allowed = False
            with self.assertRaises(PermissionError):
                await bridge._download_file("https://files.slack.com/files/F1", tmp, "a.png", context=context)
            self.assertEqual(session.calls, [])
            bridge.transport.audience_allowed = True
            outcome = await bridge._download_file("https://files.slack.com/files/F1", tmp, "a.png", context=context)
            self.assertEqual(Path(outcome.path).read_bytes(), b"onetwo")
            self.assertGreaterEqual(bridge.transport.delivery_checks, 8)
            self.assertFalse(session.calls[0][2]["allow_redirects"])

    async def test_slack_download_revoked_during_bytes_or_redirect_never_dispatches(self):
        bridge = self.slack()
        def revoke(index):
            if index == 1:
                bridge.transport.allowed = False
        session = _Session(_Response(chunks=[b"one", b"two"], on_chunk=revoke))
        bridge._audio_session = AsyncMock(return_value=session)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(PermissionError):
                await bridge._download_file("https://files.slack.com/files/F1", tmp, "a.png", context=self.context())
            self.assertEqual(list(Path(tmp).iterdir()), [])
            bridge.transport.allowed = True
            session.response = _Response(status=302)
            outcome = await bridge._download_file("https://files.slack.com/files/F1", tmp, "a.png", context=self.context())
            self.assertIsNone(outcome.path)
            self.assertEqual(list(Path(tmp).iterdir()), [])
            before = len(session.calls)
            outcome = await bridge._download_file("https://other.invalid/secret", tmp, "a.png", context=self.context())
            self.assertIsNone(outcome.path)
            self.assertEqual(len(session.calls), before)

    async def test_slack_external_upload_streams_then_publishes_exact_thread(self):
        bridge = self.slack()
        client = _SlackClient()
        response = _Response(chunks=[b"OK"])
        session = _Session(response)
        bridge._audio_session = AsyncMock(return_value=session)
        await bridge.authorize_context(self.context(thread="10.1", kind="thread"))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            data = b"A" * MEDIA_CHUNK_BYTES + b"B"
            path.write_bytes(data)
            await bridge.send_attachment(_SlackTarget(client, "C1", "U1", "10.1"),
                                         SimpleNamespace(path=str(path), filename="image.png", caption=None))
            self.assertEqual(bytes(response.uploaded), data)
            self.assertEqual(client.slots, [{"filename": "image.png", "length": len(data)}])
            self.assertEqual(client.completions[0]["channel_id"], "C1")
            self.assertEqual(client.completions[0]["thread_ts"], "10.1")
            self.assertNotIn("Authorization", session.calls[0][2]["headers"])
            self.assertFalse(session.calls[0][2]["allow_redirects"])
            self.assertEqual(path.read_bytes(), data)

    async def test_slack_upload_revocation_never_completes_or_retries(self):
        bridge = self.slack()
        client = _SlackClient()
        response = _Response(chunks=[b"OK"])
        response.on_write = lambda chunk: setattr(bridge.transport, "allowed", False)
        session = _Session(response)
        bridge._audio_session = AsyncMock(return_value=session)
        await bridge.authorize_context(self.context())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.pdf"
            path.write_bytes(b"A" * MEDIA_CHUNK_BYTES + b"B")
            with self.assertRaises(PermissionError):
                await bridge.send_attachment(_SlackTarget(client, "C1", "U1"), SimpleNamespace(path=str(path)))
            self.assertEqual(len(response.uploaded), MEDIA_CHUNK_BYTES)
            self.assertEqual(client.completions, [])
            self.assertEqual(len(session.calls), 1)
            self.assertTrue(path.exists())

    async def test_slack_root_channel_reply_threads_but_threaded_dm_stays_private(self):
        bridge = self.slack()
        client = _SlackClient()
        await bridge.handle_event({"type": "app_mention", "user": "U1", "channel": "C1", "text": "<@BOT> question",
                                   "ts": "10.1"}, client, account_id="T1", event_id="E1")
        self.assertEqual(bridge.last_target.thread_ts, "10.1")
        self.assertEqual(bridge.transport.requests[-1][0].context.conversation_kind, "channel")
        self.assertIsNone(bridge.transport.requests[-1][0].context.thread_id)
        await bridge.handle_event({"type": "message", "user": "U1", "channel": "D1", "channel_type": "im",
                                   "text": "private", "ts": "11.2", "thread_ts": "11.1"},
                                  client, account_id="T1", event_id="E2")
        request = bridge.transport.requests[-1][0]
        self.assertEqual(request.context.conversation_kind, "direct")
        self.assertEqual(request.context.thread_id, "11.1")
        self.assertEqual(bridge.last_target.thread_ts, "11.1")

    async def test_slack_audio_keeps_canonical_file_and_uses_host_speech_or_explicit_fallback(self):
        cases = (("voice.mp3", "audio/mpeg", False),
                 ("voice.webm", "audio/webm", True),
                 ("voice.m4a", "audio/mp4", False),
                 ("recording.bin", "audio/x-provider-format", False))
        for filename, mime, threaded in cases:
            for transcript in ("spoken words", None):
                with self.subTest(filename=filename, transcript=transcript, threaded=threaded):
                    bridge = self.slack()
                    bridge.transport.transcript = transcript
                    bridge._audio_session = AsyncMock(return_value=_Session(_Response(chunks=[b"audio-bytes"])))
                    event = {"type": "app_mention" if threaded else "message", "user": "U1",
                        "channel": "C1" if threaded else "D1", "channel_type": "channel" if threaded else "im",
                        "text": "<@BOT>" if threaded else "", "ts": "10.1",
                        "files": [{"id": "F1", "name": filename, "mimetype": mime,
                            "size": 11, "url_private_download": "https://files.slack.com/files/F1"}]}
                    if threaded:
                        event["thread_ts"] = "10.0"
                    await bridge.handle_event(event, _SlackClient(), account_id="T1", event_id="E1")
                    request, files = bridge.transport.requests[0]
                    self.assertIn(transcript or VOICE_FALLBACK, request.parts[0].text)
                    original = request.parts[1].attachment
                    self.assertEqual((original.kind, original.mime_type, original.provider_attachment_id), ("voice", mime, "F1"))
                    self.assertEqual(request.source, "voice")
                    self.assertEqual(files, (b"audio-bytes",))
                    speech_context, speech_attachment, speech_bytes = bridge.transport.transcriptions[0]
                    self.assertEqual((speech_attachment.kind, speech_attachment.filename, speech_attachment.mime_type,
                                      speech_attachment.provider_attachment_id), ("voice", filename, mime, "F1"))
                    expected_identity = ("U1", "T1", event["channel"], event.get("thread_ts"), "E1")
                    for current in (speech_context, request.context):
                        self.assertEqual((current.actor_id, current.account_id, current.conversation_id,
                                          current.thread_id, current.event_id), expected_identity)
                    self.assertEqual(speech_bytes, b"audio-bytes")
                    self.assertEqual(bridge.last_target.thread_ts, event.get("thread_ts"))
                    self.assertFalse(Path(original.local_path).exists())  # turn-owned cleanup

    async def test_slack_audio_revoked_during_speech_has_no_runtime_submission(self):
        bridge = self.slack()
        bridge.transport.on_transcribe = lambda: setattr(bridge.transport, "allowed", False)
        bridge._audio_session = AsyncMock(return_value=_Session(_Response(chunks=[b"voice"])))
        await bridge.handle_event({"type": "message", "user": "U1", "channel": "D1", "channel_type": "im", "ts": "10.1",
            "files": [{"id": "F1", "name": "voice.ogg", "mimetype": "audio/ogg", "size": 5,
                       "url_private_download": "https://files.slack.com/files/F1"}]},
            _SlackClient(), account_id="T1", event_id="E1")
        self.assertEqual(len(bridge.transport.transcriptions), 1)
        self.assertEqual(bridge.transport.requests, [])

    async def test_slack_new_audience_during_speech_cannot_inherit_original_input(self):
        bridge = self.slack()
        bridge.transport.on_transcribe = lambda: setattr(bridge.transport, "new_member", True)
        bridge._audio_session = AsyncMock(return_value=_Session(_Response(chunks=[b"voice"])))
        await bridge.handle_event({"type": "app_mention", "user": "U1", "channel": "C1", "ts": "10.1",
            "thread_ts": "10.0", "text": "<@BOT>", "files": [{"id": "F1", "name": "voice.webm",
            "mimetype": "audio/webm", "size": 5, "url_private_download": "https://files.slack.com/files/F1"}]},
            _SlackClient(), account_id="T1", event_id="E1")
        self.assertEqual(len(bridge.transport.transcriptions), 1)
        self.assertEqual(bridge.transport.requests, [])

    async def test_discord_download_verifies_sdk_route_and_audience_then_streams(self):
        bridge = self.discord()
        context = self.context("discord", conversation="33")
        attachment = SimpleNamespace(id=44, size=6, url="https://cdn.discordapp.com/attachments/33/44/file.png?ex=fixture")
        session = _Session(_Response(chunks=[b"one", b"two"]))
        bridge._new_media_session = lambda: session
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            bridge.transport.audience_allowed = False
            with self.assertRaises(PermissionError):
                await bridge._download_attachment(attachment, path, context=context, channel_id="33")
            self.assertEqual(session.calls, [])
            bridge.transport.audience_allowed = True
            self.assertEqual(await bridge._download_attachment(attachment, path, context=context, channel_id="33"), 6)
            self.assertEqual(path.read_bytes(), b"onetwo")
            self.assertTrue(session.closed)
            self.assertFalse(session.calls[0][2]["allow_redirects"])
            attachment.url = "https://cdn.discordapp.com/attachments/999/44/file.png"
            with self.assertRaises(PermissionError):
                await bridge._download_attachment(attachment, path, context=context, channel_id="33")

    async def test_discord_download_revocation_cleans_partial_and_preserves_existing(self):
        bridge = self.discord()
        context = self.context("discord", conversation="33")
        attachment = SimpleNamespace(id=44, size=0, url="https://cdn.discordapp.com/attachments/33/44/file.png")
        def revoke(index):
            if index == 1:
                bridge.transport.allowed = False
        session = _Session(_Response(chunks=[b"one", b"two"], on_chunk=revoke))
        bridge._new_media_session = lambda: session
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            with self.assertRaises(PermissionError):
                await bridge._download_attachment(attachment, path, context=context, channel_id="33")
            self.assertFalse(path.exists())
            bridge.transport.allowed = True
            path.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):
                await bridge._download_attachment(attachment, path, context=context, channel_id="33")
            self.assertEqual(path.read_bytes(), b"existing")

    async def test_discord_multipart_output_streams_and_verifies_response(self):
        bridge = self.discord()
        response = _Response(chunks=[json.dumps({"id": "55", "channel_id": "33", "attachments": [{"id": "66"}]}).encode()])
        session = _Session(response)
        bridge._new_media_session = lambda: session
        await bridge.authorize_context(self.context("discord", conversation="33"))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            path.write_bytes(b"A" * MEDIA_CHUNK_BYTES + b"B")
            await bridge.send_attachment(SimpleNamespace(id=33), SimpleNamespace(path=str(path), filename="image.png", mime_type="image/png"))
            self.assertIn(b"A" * MEDIA_CHUNK_BYTES + b"B", response.uploaded)
            self.assertIn(b'"allowed_mentions": {"parse": []}', response.uploaded)
            self.assertEqual(session.calls[0][1], "https://discord.com/api/v10/channels/33/messages")
            self.assertFalse(session.calls[0][2]["allow_redirects"])
            self.assertTrue(path.exists())
            self.assertTrue(session.closed)

    async def test_discord_upload_revoked_between_chunks_stops_without_retry(self):
        bridge = self.discord()
        response = _Response()
        def revoke(chunk):
            if chunk == b"A" * MEDIA_CHUNK_BYTES:
                bridge.transport.allowed = False
        response.on_write = revoke
        session = _Session(response)
        bridge._new_media_session = lambda: session
        await bridge.authorize_context(self.context("discord", conversation="33"))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            path.write_bytes(b"A" * MEDIA_CHUNK_BYTES + b"B")
            with self.assertRaises(PermissionError):
                await bridge.send_attachment(SimpleNamespace(id=33), SimpleNamespace(path=str(path), filename="image.png"))
            self.assertNotIn(b"A" * MEDIA_CHUNK_BYTES + b"B", response.uploaded)
            self.assertEqual(len(session.calls), 1)
            self.assertTrue(path.exists())

    async def _discord_audio_event(self, *, transcript="spoken words", revoke=False,
                                   filename="audio.mp3", mime="audio/mpeg", threaded=False, audience_change=False):
        bridge = self.discord()
        bridge.transport.transcript = transcript
        if revoke:
            bridge.transport.on_transcribe = lambda: setattr(bridge.transport, "allowed", False)
        if audience_change:
            bridge.transport.on_transcribe = lambda: setattr(bridge.transport, "new_member", True)
        bridge._new_media_session = lambda: _Session(_Response(chunks=[b"audio-bytes"]))
        bot = SimpleNamespace(id=999)
        channel_id = 34 if threaded else 33
        bridge.listen_channels.add(str(channel_id))
        # Native Discord voice metadata is not used as a replacement for the
        # actual MIME/file classifier or the host's configured speech callback.
        attachment = SimpleNamespace(id=44, filename=filename, content_type=mime,
            size=11, duration=1.5, waveform=b"\x00\x80\xff",
            url=f"https://cdn.discordapp.com/attachments/{channel_id}/44/{filename}")
        message = SimpleNamespace(id=55, author=SimpleNamespace(id=7, bot=False, display_name="Human"),
            guild=SimpleNamespace(id=22), channel=SimpleNamespace(id=channel_id, parent_id=33 if threaded else None),
            reference=None, flags=SimpleNamespace(voice=filename.endswith((".ogg", ".opus"))),
            mentions=[bot], content="<@999>", attachments=[attachment])
        class Client:
            def __init__(self, **kwargs):
                self.user = bot
            def event(self, function):
                setattr(self, function.__name__, function)
                return function
            async def start(self, token):
                await self.on_message(message)
        class Tree:
            def __init__(self, client):
                pass
            def command(self, **kwargs):
                return lambda function: function
        # Exercise the real callback registered by DiscordBridge._run. The only
        # fake is the SDK network boundary, not the bridge or host speech path.
        with patch("discord.Client", Client), patch("discord.app_commands.CommandTree", Tree):
            if revoke or audience_change:
                with self.assertRaises(PermissionError):
                    await bridge._run()
            else:
                await bridge._run()
        return bridge

    async def test_discord_audio_original_and_transcript_reach_same_host_context(self):
        cases = (("audio.mp3", "audio/mpeg", False),
                 ("voice.ogg", "audio/ogg", True),
                 ("voice.opus", "audio/opus", False))
        for filename, mime, threaded in cases:
            for transcript in ("spoken words", None):
                with self.subTest(filename=filename, transcript=transcript, threaded=threaded):
                    bridge = await self._discord_audio_event(transcript=transcript, filename=filename,
                                                             mime=mime, threaded=threaded)
                    request, files = bridge.transport.requests[0]
                    self.assertIn(transcript or VOICE_FALLBACK, request.parts[0].text)
                    attachment = request.parts[1].attachment
                    self.assertEqual((attachment.kind, attachment.mime_type, attachment.provider_attachment_id),
                                     ("voice", mime, "44"))
                    self.assertEqual(request.source, "voice")
                    self.assertEqual(files, (b"audio-bytes",))
                    speech_context, speech_attachment, speech_bytes = bridge.transport.transcriptions[0]
                    self.assertEqual((speech_attachment.kind, speech_attachment.filename, speech_attachment.mime_type,
                                      speech_attachment.provider_attachment_id), ("voice", filename, mime, "44"))
                    expected_identity = ("7", "22", "33", "34" if threaded else None, "55")
                    for current in (speech_context, request.context):
                        self.assertEqual((current.actor_id, current.account_id, current.conversation_id,
                                          current.thread_id, current.event_id), expected_identity)
                    self.assertEqual(speech_bytes, b"audio-bytes")
                    self.assertFalse(Path(attachment.local_path).exists())

    async def test_discord_thread_media_never_uses_parent_as_transfer_destination(self):
        bridge = self.discord()
        context = BridgeContext("binding", "discord", "22", "7", "33", "55",
                                thread_id="34", conversation_kind="thread")
        session = _Session(_Response(chunks=[b"bytes"]))
        bridge._new_media_session = lambda: session
        await bridge.authorize_context(context)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "file.png"
            path.write_bytes(b"bytes")
            with self.assertRaises(PermissionError):
                await bridge.send_attachment(SimpleNamespace(id=33), SimpleNamespace(path=str(path), filename="file.png"))
            with self.assertRaises(PermissionError):
                await bridge._download_attachment(SimpleNamespace(id=44, size=5,
                    url="https://cdn.discordapp.com/attachments/33/44/file.png"), Path(tmp) / "in.png",
                    context=context, channel_id="33")
            self.assertEqual(session.calls, [])
            self.assertFalse((Path(tmp) / "in.png").exists())

    async def test_discord_revocation_during_speech_prevents_runtime_submission(self):
        bridge = await self._discord_audio_event(revoke=True)
        self.assertEqual(len(bridge.transport.transcriptions), 1)
        self.assertEqual(bridge.transport.requests, [])

    async def test_discord_new_audience_during_speech_cannot_inherit_original_input(self):
        bridge = await self._discord_audio_event(filename="voice.ogg", mime="audio/ogg", threaded=True, audience_change=True)
        self.assertEqual(len(bridge.transport.transcriptions), 1)
        self.assertEqual(bridge.transport.requests, [])
