"""No provider network or SDK is needed to qualify the host IPC boundary."""
import asyncio
import base64
from dataclasses import replace
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from openagent_channel_bridges.contracts import (
    BridgeAttachment, BridgeCommand, BridgeContext, BridgeEvent, BridgeMessage,
    BridgePart, BridgeReply,
)
from openagent_channel_bridges.stdio import (
    HostClosed, HostRejected, MAX_PENDING, StdioBridgeTransport, configure,
    describe, main, serve,
)
from openagent_channel_bridges.wire import (
    ArtifactStore, MAX_CHUNK, MAX_FILES, MAX_LINE, PROTOCOL, WireError,
    decode_line, encode_line,
)


def context(actor="alice", event="event"):
    return BridgeContext("binding", "slack", "team", actor, "channel", event, "thread")


def frame(kind, request_id, **kwargs):
    return {"protocol": PROTOCOL, "type": kind, "request_id": request_id, **kwargs}


def message(actor="alice", event="event", parts=None):
    return BridgeMessage(context(actor, event), parts or (BridgePart(text="question"),))


def fixture_transport():
    queue = asyncio.Queue()
    async def write(line):
        await queue.put(decode_line(line))
    return StdioBridgeTransport(write, binding_id="binding", provider="slack"), queue


@pytest.mark.asyncio
async def test_interleaved_requests_preserve_original_author_and_correlation():
    transport, queue = fixture_transport()
    alice = asyncio.create_task(transport.send(message()))
    bob = asyncio.create_task(transport.send(message("bob", "other")))
    try:
        first, second = await queue.get(), await queue.get()
        assert first["params"]["context"]["actor_id"] == "alice"
        assert second["params"]["context"]["actor_id"] == "bob"
        await transport.receive(frame("result", second["request_id"], result={"parts": [{"text": "B"}]}))
        await transport.receive(frame("result", first["request_id"], result={"parts": [{"text": "A"}]}))
        assert (await alice).parts == (BridgePart(text="A"),)
        assert (await bob).parts == (BridgePart(text="B"),)
        with pytest.raises(WireError):
            await transport.receive(frame("result", first["request_id"], result={}))
    finally:
        transport.close()
        await asyncio.gather(alice, bob, return_exceptions=True)


@pytest.mark.asyncio
async def test_progress_nested_authorization_does_not_deadlock_reader():
    transport, queue = fixture_transport()
    seen = []
    async def on_event(event):
        assert await transport.authorize_context(context()) is True
        seen.append(event.text)
    task = asyncio.create_task(transport.send(message(), on_event=on_event))
    try:
        request = await queue.get()
        await transport.receive(frame("event", request["request_id"], event={"kind": "status", "text": "working"}))
        nested = await queue.get()
        assert nested["method"] == "authorize_context"
        await transport.receive(frame("result", nested["request_id"], result=True))
        await transport.receive(frame("result", request["request_id"], result={"parts": []}))
        assert isinstance(await task, BridgeReply)
        assert seen == ["working"]
    finally:
        transport.close()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_completed_progress_is_pruned_and_callback_failure_blocks_reply():
    transport, queue = fixture_transport()
    seen = asyncio.Queue()
    async def on_event(event):
        if event.text == "denied":
            raise PermissionError("revoked")
        await seen.put(event.text)
    task = asyncio.create_task(transport.send(message(), on_event=on_event))
    request = await queue.get()
    try:
        pending = transport._pending[request["request_id"]]
        for number in range(128):
            await transport.receive(frame("event", request["request_id"], event={"kind": "text", "text": str(number)}))
            assert await seen.get() == str(number)
            await asyncio.sleep(0)  # permit the completion/pruning callback
            assert len(pending.events) <= 1
        await transport.receive(frame("event", request["request_id"], event={"kind": "text", "text": "denied"}))
        await transport.receive(frame("result", request["request_id"], result={"parts": [{"text": "must not deliver"}]}))
        with pytest.raises(PermissionError, match="revoked"):
            await task
    finally:
        transport.close()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_wrong_binding_never_emits_and_host_error_text_is_not_accepted():
    transport, queue = fixture_transport()
    with pytest.raises(PermissionError):
        await transport.authorize_context(replace(context(), binding_id="other"))
    assert queue.empty()
    task = asyncio.create_task(transport.authorize_context(context()))
    request = await queue.get()
    try:
        with pytest.raises(WireError):
            await transport.receive(frame("error", request["request_id"], error={"code": "denied", "message": "secret"}))
        await transport.receive(frame("error", request["request_id"], error={"code": "denied"}))
        with pytest.raises(HostRejected, match="^channel_host_rejected$"):
            await task
    finally:
        transport.close()


@pytest.mark.asyncio
async def test_result_cannot_replace_sdk_context_or_supply_local_path(tmp_path):
    transport, queue = fixture_transport()
    for invalid in ({"context": {"actor_id": "owner"}},
                    {"parts": [{"attachment": {"local_path": str(tmp_path / "private")}}]}):
        task = asyncio.create_task(transport.send(message()))
        request = await queue.get()
        await transport.receive(frame("result", request["request_id"], result=invalid))
        with pytest.raises(WireError):
            await task
    transport.close()


@pytest.mark.asyncio
async def test_eof_cancels_only_pending_bridge_requests_and_invalidates_handles(tmp_path):
    transport, queue = fixture_transport()
    source = tmp_path / "owned"; source.write_bytes(b"provider file")
    task = asyncio.create_task(transport.send(message(parts=(BridgePart(attachment=BridgeAttachment(
        "file", "source.txt", local_path=str(source), owned=True)),))))
    request = await queue.get()
    attachment = request["params"]["parts"][0]["attachment"]
    assert "local_path" not in attachment and "owned" not in attachment
    assert attachment["sha256"] == hashlib.sha256(b"provider file").hexdigest()
    transport.eof()
    with pytest.raises(HostClosed):
        await task
    assert not source.exists()
    with pytest.raises(WireError):
        transport.artifacts.read(request["request_id"], {"reader_ref": attachment["reader_ref"], "offset": 0, "length": 4})
    transport.close()


def test_artifact_read_is_scoped_bounded_and_rejects_changed_files(tmp_path):
    store = ArtifactStore(); source = tmp_path / "input"; source.write_bytes(b"abcdef")
    try:
        store.begin("a"); store.begin("b")
        value = store.register("a", BridgeAttachment("file", "file.txt", local_path=str(source), provider_attachment_id="provider-id"))
        assert value["provider_attachment_id"] == "provider-id"
        params = {"reader_ref": value["reader_ref"], "offset": 2, "length": 3}
        assert base64.b64decode(store.read("a", params)["data_base64"]) == b"cde"
        with pytest.raises(WireError):
            store.read("b", params)
        with pytest.raises(WireError):
            store.read("a", {**params, "length": MAX_CHUNK + 1})
        source.write_bytes(b"changed")
        with pytest.raises(WireError, match="artifact_changed"):
            store.read("a", params)
    finally:
        store.close()
    assert source.read_bytes() == b"changed"  # an unowned provider file survives


def test_upload_requires_exact_size_hash_and_request_then_uses_owned_tempfile(tmp_path):
    store = ArtifactStore()
    try:
        store.begin("one"); store.begin("two")
        data = b"reply media\x00\xff"
        ref = store.upload_begin("one", {"kind": "file", "filename": "reply.bin", "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})["reader_ref"]
        with pytest.raises(WireError, match="incomplete_artifact"):
            store.resolve("one", {"reader_ref": ref})
        with pytest.raises(WireError):
            store.upload_chunk("two", {"reader_ref": ref, "offset": 0, "data_base64": base64.b64encode(data).decode()})
        params = {"reader_ref": ref, "offset": 0, "data_base64": base64.b64encode(data).decode()}
        store.upload_chunk("one", params)
        with pytest.raises(WireError):
            store.upload_chunk("one", params)  # no replay/append
        store.upload_finish("one", {"reader_ref": ref})
        attachment = store.resolve("one", {"reader_ref": ref})
        assert attachment.owned and Path(attachment.local_path).read_bytes() == data
        assert Path(attachment.local_path).parent != tmp_path
        store.end("one")
        assert Path(attachment.local_path).exists()  # platform delivery follows RPC result
        with pytest.raises(WireError):
            store.resolve("two", {"reader_ref": ref})
        path = attachment.local_path
    finally:
        store.close()
    assert not Path(path).exists()


def test_upload_rejects_path_injection_hash_mismatch_symlink_and_file_flood(tmp_path):
    store = ArtifactStore(); store.begin("one")
    params = {"kind": "file", "filename": "good", "size_bytes": 1, "sha256": "0" * 64}
    try:
        with pytest.raises(ValueError):
            store.upload_begin("one", {**params, "filename": "../escape"})
        with pytest.raises(WireError):
            store.upload_begin("one", {**params, "local_path": str(tmp_path / "escape")})
        source = tmp_path / "source"; source.write_bytes(b"x")
        link = tmp_path / "link"; link.symlink_to(source)
        with pytest.raises(WireError):
            store.register("one", BridgeAttachment("file", "link", local_path=str(link)))
        ref = store.upload_begin("one", params)["reader_ref"]
        store.upload_chunk("one", {"reader_ref": ref, "offset": 0, "data_base64": "eA=="})
        with pytest.raises(WireError, match="artifact_hash_mismatch"):
            store.upload_finish("one", {"reader_ref": ref})
        for _ in range(MAX_FILES - 1):
            store.upload_begin("one", params)
        with pytest.raises(WireError, match="artifact_limit"):
            store.upload_begin("one", params)
    finally:
        store.close()


def test_artifact_quota_recovers_after_input_completion_and_output_delivery(tmp_path, monkeypatch):
    monkeypatch.setattr("openagent_channel_bridges.wire.MAX_SESSION_BYTES", 8)
    store = ArtifactStore(); source = tmp_path / "input"; source.write_bytes(b"12345678")
    try:
        for number in range(3):
            request_id = f"input-{number}"
            store.begin(request_id)
            store.register(request_id, BridgeAttachment("file", "input", local_path=str(source)))
            store.end(request_id)
        assert source.exists()
        for number in range(3):
            request_id = f"output-{number}"
            store.begin(request_id)
            data = b"12345678"
            ref = store.upload_begin(request_id, {"kind": "file", "filename": "reply", "size_bytes": 8,
                "sha256": hashlib.sha256(data).hexdigest()})["reader_ref"]
            store.upload_chunk(request_id, {"reader_ref": ref, "offset": 0, "data_base64": base64.b64encode(data).decode()})
            store.upload_finish(request_id, {"reader_ref": ref})
            attachment = store.resolve(request_id, {"reader_ref": ref})
            store.end(request_id)
            assert attachment.owned and Path(attachment.local_path).exists()
            # The provider's normal delivery finally removes an owned output.
            Path(attachment.local_path).unlink()
    finally:
        store.close()


def test_input_hash_rechecks_file_after_read_before_emitting_reference(tmp_path, monkeypatch):
    import openagent_channel_bridges.wire as wire
    source = tmp_path / "input"; source.write_bytes(b"before")
    original = wire.os.fstat
    calls = 0
    def fstat(fd):
        nonlocal calls
        calls += 1
        if calls == 2:
            source.write_bytes(b"changed after hashing")
        return original(fd)
    store = ArtifactStore(); store.begin("request")
    try:
        monkeypatch.setattr(wire.os, "fstat", fstat)
        with pytest.raises(WireError, match="artifact_changed"):
            store.register("request", BridgeAttachment("file", "input", local_path=str(source)))
    finally:
        store.close()


@pytest.mark.asyncio
async def test_host_artifact_rpc_is_bound_to_pending_request_and_expired_after_result():
    transport, queue = fixture_transport()
    task = asyncio.create_task(transport.send(message()))
    request = await queue.get()
    host = frame("request", "host-1", parent_request_id=request["request_id"], method="upload_begin",
                 params={"kind": "file", "filename": "empty", "size_bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()})
    try:
        await transport.receive(host)
        begin = await queue.get(); ref = begin["result"]["reader_ref"]
        await transport.receive({**host, "request_id": "host-2", "method": "upload_finish", "params": {"reader_ref": ref}})
        assert (await queue.get())["type"] == "result"
        await transport.receive(frame("result", request["request_id"], result={"parts": [{"attachment": {"reader_ref": ref}}]}))
        reply = await task
        assert reply.parts[0].attachment.size_bytes == 0
        await transport.receive(host)
        assert (await queue.get())["error"] == {"code": "artifact_rejected"}
    finally:
        transport.close()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_pending_limit_and_shutdown_do_not_construct_any_host_runtime():
    transport, queue = fixture_transport()
    tasks = [asyncio.create_task(transport.authorize_context(context(event=str(n)))) for n in range(MAX_PENDING)]
    try:
        for _ in tasks:
            await queue.get()
        with pytest.raises(WireError, match="pending_limit"):
            await transport.authorize_context(context())
        transport.eof()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        assert all(isinstance(result, HostClosed) for result in results)
    finally:
        transport.close()


@pytest.mark.asyncio
async def test_serve_configure_then_eof_stops_only_injected_bridge():
    incoming = asyncio.Queue(); outgoing = asyncio.Queue(); stopped = asyncio.Event()
    config = frame("configure", "setup", provider="slack", binding_id="binding", config={"bot_token": "DO_NOT_PRINT"})
    await incoming.put(encode_line(config))
    class Bridge:
        async def start(self):
            await asyncio.Future()
        async def stop(self):
            stopped.set()
    async def write(line):
        await outgoing.put(line)
    runner = asyncio.create_task(serve(incoming.get, write, factory=lambda f, t: Bridge()))
    response = await outgoing.get()
    assert b"DO_NOT_PRINT" not in response
    assert decode_line(response)["type"] == "configured"
    await incoming.put(b"")
    assert await runner == 0 and stopped.is_set()


def test_strict_metadata_lines_duplicate_fields_ids_and_config_reject_without_sdk_import():
    for line in (b'{"protocol":"channel-bridge-ipc/v1","type":"a","type":"b"}\n',
                 b'{"protocol":"channel-bridge-ipc/v1","x":NaN}\n', b"{}", b"x" * (MAX_LINE + 1)):
        with pytest.raises(WireError):
            decode_line(line)
    with pytest.raises(WireError):
        encode_line({"protocol": PROTOCOL, "x": "x" * MAX_LINE})
    config = frame("configure", "setup", provider="slack", binding_id="binding", config={"bot_token": "secret", "runtime": "forbidden"})
    with pytest.raises(WireError):
        configure(config, object())
    config["config"] = {"bot_token": "secret", "live": "false"}
    with pytest.raises(WireError):
        configure(config, object())
    assert describe()["protocol"] == PROTOCOL


def test_describe_is_nonsecret_and_unknown_arguments_exit_two(monkeypatch):
    output, error = io.BytesIO(), io.StringIO()
    monkeypatch.setattr("sys.stdout", SimpleNamespace(buffer=output))
    monkeypatch.setattr("sys.stderr", error)
    assert main(["--describe"]) == 0
    assert decode_line(output.getvalue())["providers"] == ["slack", "discord", "telegram", "whatsapp"]
    assert main(["--unknown", "DO_NOT_PRINT"]) == 2
    assert "DO_NOT_PRINT" not in error.getvalue()
