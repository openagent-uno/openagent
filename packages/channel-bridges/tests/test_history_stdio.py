"""Real NDJSON socket IO; provider fixtures never contact an external account."""
import asyncio
import base64
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
import socket
from types import SimpleNamespace

import pytest

import test_provider_context as provider_fixtures
from openagent_channel_bridges import history as history_module
from openagent_channel_bridges.history import HistoryUnavailable
from openagent_channel_bridges.stdio import StdioBridgeTransport
from openagent_channel_bridges.wire import PROTOCOL, decode_line, encode_line


class Host:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.requests, self.readers, self.children = [], [], set()
        self.pending, self.serial, self.failures = {}, 0, []
        self.allowed = True
        self.authorization_delay = 0
        self.stall = None
        self.stalled = asyncio.Event()

    async def emit(self, value):
        self.writer.write(encode_line({"protocol": PROTOCOL, **value}))
        await self.writer.drain()

    async def call(self, method, params, *, parent=None):
        self.serial += 1
        identifier = f"host-{self.serial}"
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        try:
            value = {"type": "request", "request_id": identifier,
                     "method": method, "params": params}
            if parent is not None:
                value["parent_request_id"] = parent
            await self.emit(value)
            return await future
        finally:
            self.pending.pop(identifier, None)

    async def loop(self):
        while line := await self.reader.readline():
            frame = decode_line(line)
            if frame["type"] == "request":
                task = asyncio.create_task(self.handle(frame))
                self.children.add(task)
                def completed(task):
                    self.children.discard(task)
                    if not task.cancelled() and task.exception() is not None:
                        self.failures.append(task.exception())
                task.add_done_callback(completed)
            else:
                self.pending[frame["request_id"]].set_result(frame)

    async def handle(self, frame):
        self.requests.append(frame)
        method, params = frame["method"], frame["params"]
        if method == self.stall:
            self.stall = None  # One stalled request cannot block the reader.
            self.stalled.set()
            return
        if method == "start":
            result = {"input_media": ["voice"], "history_media": True}
        elif method in ("authorize_context", "authorize_delivery"):
            await asyncio.sleep(self.authorization_delay)
            result = self.allowed
        elif method in ("transcribe", "send"):
            values = ([params["attachment"]] if method == "transcribe" else
                      [part["attachment"] for record in params["history"]
                       for part in record["parts"] if part.get("attachment")])
            for attachment in values:
                assert "local_path" not in attachment and "url" not in attachment
                reader = attachment["reader_ref"]
                response = await self.call("read_artifact", {
                    "reader_ref": reader, "offset": 0, "length": 65536},
                    parent=frame["request_id"])
                assert response["type"] == "result"
                assert base64.b64decode(response["result"]["data_base64"]) == b"synthetic audio"
                self.readers.append((frame["request_id"], reader))
            result = "Quoted speech." if method == "transcribe" else {"parts": [{"text": "Final."}]}
        elif method == "stop":
            result = None
        else:
            raise AssertionError(method)
        await self.emit({"type": "result", "request_id": frame["request_id"], "result": result})


@asynccontextmanager
async def ipc(provider, binding):
    child_socket, host_socket = socket.socketpair()
    child_reader, child_writer = await asyncio.open_connection(sock=child_socket, limit=2 << 20)
    host_reader, host_writer = await asyncio.open_connection(sock=host_socket, limit=2 << 20)
    async def write(line):
        child_writer.write(line)
        await child_writer.drain()
    transport = StdioBridgeTransport(write, provider=provider, binding_id=binding)
    host = Host(host_reader, host_writer)
    async def child_loop():
        while line := await child_reader.readline():
            await transport.receive(decode_line(line))
    tasks = [asyncio.create_task(child_loop()), asyncio.create_task(host.loop())]
    try:
        yield transport, host
    finally:
        transport.eof()
        tasks.extend(host.children)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        transport.close()
        for writer in (child_writer, host_writer):
            writer.close()
            await writer.wait_closed()
        assert not host.failures, host.failures


def fixture(provider, transport, directory, *, voice=False):
    fixtures = provider_fixtures.ProviderContextTests()
    if provider == "slack":
        bridge, _ = fixtures.slack()
        rows = [{"ts": f"{i}.0", "user": "Uother", "text": f"quoted-{i}"}
                for i in range(20, 0, -1)]
        if voice:
            rows[-1]["files"] = [{"id": "Fvoice", "name": "voice.ogg",
                "mimetype": "audio/ogg", "size": 15,
                "url_private_download": "https://files.slack.com/Fvoice"}]
        source = provider_fixtures.SlackClient(pages=[rows])
        context = bridge._bridge_context(account="Tfixture", actor="Uactor",
            channel="Cfixture", event="50.0")
        bridge._event_clients[bridge._event_key(context)] = source
        async def download(url, target, filename, **kwargs):
            path = Path(target) / filename
            path.write_bytes(b"synthetic audio")
            return str(path)
        bridge._download_file = download
        kwargs = {"is_dm": False, "trigger_ts": "50.0"}
    else:
        bridge, _, channel, _ = fixtures.discord()
        channel.messages = [provider_fixtures.discord_message(channel, i, actor="8",
                             text=f"quoted-{i}") for i in range(20, 0, -1)]
        if voice:
            channel.messages[-1].attachments = [SimpleNamespace(id=123, filename="voice.ogg",
                content_type="audio/ogg", size=15)]
        source = provider_fixtures.discord_message(channel, 50)
        context = bridge._bridge_context(source)
        async def download(attachment, path, **kwargs):
            path.write_bytes(b"synthetic audio")
        bridge._download_attachment = download
        kwargs = {}
    bridge.transport = transport
    transport.attest_context = bridge.attest_context
    return bridge, source, context, {**kwargs, "media_directory": str(directory)}


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["slack", "discord"])
async def test_twenty_history_records_and_voice_use_real_ipc_with_concurrent_attestation(tmp_path, provider):
    async with ipc(provider, f"binding-{provider}") as (transport, host):
        bridge, source, context, kwargs = fixture(provider, transport, tmp_path, voice=True)
        await bridge._ensure_transport_started()
        prepared, attested = await asyncio.wait_for(asyncio.gather(
            bridge._history(source, context, **kwargs),
            host.call("attest_context", {"context": asdict(context)})), 3)
        assert attested["type"] == "result"
        assert len(prepared) == 20
        assert [record.event_id for record in prepared] == [
            f"{i}.0" if provider == "slack" else str(i) for i in range(1, 21)]
        assert {record.actor_id for record in prepared} == {"Uother" if provider == "slack" else "8"}
        assert any(part.text == "Audio transcript (quoted historical message):\nQuoted speech."
                   for part in prepared[0].parts)
        result = await asyncio.wait_for(bridge.send_message("current human", context=context,
                                                           history=prepared), 3)
        assert result["text"] == "Final."
        sent = [frame for frame in host.requests if frame["method"] == "send"]
        assert len(sent) == 1
        assert sent[0]["params"]["context"]["actor_id"] == context.actor_id
        assert sent[0]["params"]["context"]["conversation_id"] == context.conversation_id
        assert len(sent[0]["params"]["history"]) == 20
        assert len(host.readers) == 2  # Same staged speech, distinct parent scopes.
        for parent, reader in host.readers:
            expired = await host.call("read_artifact", {"reader_ref": reader, "offset": 0, "length": 1}, parent=parent)
            assert expired["error"] == {"code": "artifact_rejected"}
        assert all(frame["params"]["actor_id"] == context.actor_id for frame in host.requests
                   if frame["method"] in ("authorize_context", "authorize_delivery"))


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["slack", "discord"])
@pytest.mark.parametrize("phase", ["authorize_context", "provider", "transcribe"])
async def test_history_deadline_cancels_stalled_io_without_partial_submit_or_poisoning_ipc(
        tmp_path, monkeypatch, provider, phase):
    monkeypatch.setattr(history_module, "HISTORY_PREPARATION_TIMEOUT_SECONDS", 0.08)
    async with ipc(provider, f"binding-{provider}") as (transport, host):
        bridge, source, context, kwargs = fixture(provider, transport, tmp_path, voice=phase == "transcribe")
        await bridge._ensure_transport_started()
        provider_cancelled = asyncio.Event()
        if phase == "provider":
            async def stalled(**_):
                try:
                    await asyncio.Future()
                finally:
                    provider_cancelled.set()
            if provider == "slack":
                source.conversations_history = stalled
            else:
                async def iterator():
                    await stalled()
                    yield  # pragma: no cover
                source.channel.history = lambda **_: iterator()
        else:
            host.stall = phase
        with pytest.raises(HistoryUnavailable, match="timed out"):
            await asyncio.wait_for(bridge._history(source, context, **kwargs), 2)
        assert not [frame for frame in host.requests if frame["method"] == "send"]
        assert not transport._pending and not transport.artifacts._scopes
        if phase == "provider":
            assert provider_cancelled.is_set()
        else:
            assert host.stalled.is_set()
            pending = next(frame for frame in host.requests if frame["method"] == phase)
            await host.emit({"type": "result", "request_id": pending["request_id"],
                             "result": "Late transcript." if phase == "transcribe" else True})
        host.allowed = False
        # A late approval cannot authorize the next turn, and does not kill IO.
        assert await asyncio.wait_for(transport.authorize_context(context), 1) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["slack", "discord"])
async def test_history_revocation_and_external_cancellation_are_not_timeout_fallbacks(tmp_path, monkeypatch, provider):
    monkeypatch.setattr(history_module, "HISTORY_PREPARATION_TIMEOUT_SECONDS", 60)
    async with ipc(provider, f"binding-{provider}") as (transport, host):
        bridge, source, context, kwargs = fixture(provider, transport, tmp_path)
        await bridge._ensure_transport_started()
        host.allowed = False
        with pytest.raises(PermissionError):
            await bridge._history(source, context, **kwargs)
        host.allowed = True
        host.stall = "authorize_context"
        task = asyncio.create_task(bridge._history(source, context, **kwargs))
        await asyncio.wait_for(host.stalled.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not transport._pending and not transport.artifacts._scopes
        assert not [frame for frame in host.requests if frame["method"] == "send"]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["slack", "discord"])
async def test_history_deadline_is_aggregate_even_when_each_authorization_completes(tmp_path, monkeypatch, provider):
    monkeypatch.setattr(history_module, "HISTORY_PREPARATION_TIMEOUT_SECONDS", 0.1)
    async with ipc(provider, f"binding-{provider}") as (transport, host):
        bridge, source, context, kwargs = fixture(provider, transport, tmp_path)
        await bridge._ensure_transport_started()
        host.authorization_delay = 0.06
        with pytest.raises(HistoryUnavailable, match="timed out"):
            await asyncio.wait_for(bridge._history(source, context, **kwargs), 2)
        assert len([frame for frame in host.requests if frame["method"] == "authorize_context"]) >= 2
        assert not [frame for frame in host.requests if frame["method"] == "send"]
        assert not transport._pending
