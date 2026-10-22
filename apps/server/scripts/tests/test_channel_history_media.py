"""Source fixtures: normal Core CAS ingestion, no model or provider traffic."""
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import hashlib

from ._framework import TestContext, test
from .test_session_public_projection import _fixture


@test("channel_history_media", "historical files use the ordinary session-scoped ArtifactRepository")
async def t_history_media_ordinary_ingestion(ctx: TestContext) -> None:
    from openagent_core.artifacts import ArtifactRepository
    from openagent_channel_bridges.contracts import (
        BridgeAttachment, BridgeContext, BridgeHistoryMessage, BridgeMessage, BridgePart,
    )
    from openagent_server.bridges.native_transport import NativeChannelTransport
    async with _fixture() as (db, _conn, gateway, request):
        service = gateway.runtime_service
        execution = replace(await service.context(request(), "session"), ingress_id=None)
        submitted = []
        class Runtime:
            async def accepted_request(self, *args):
                raise LookupError
            async def submit(self, value, actor):
                submitted.append(value)
            async def events(self, *args):
                return [SimpleNamespace(cursor=1, kind="run.stream", payload={
                    "kind": "done", "text": "Intermediate narration and final answer",
                    "final_answer": {"text": "Only the authoritative final answer"},
                })]
            async def get_run(self, *args):
                return SimpleNamespace(terminal=True, status="success", output="legacy aggregate")
        service.runtime = Runtime()
        class Host(NativeChannelTransport):
            async def _execution(self, *args, **kwargs):
                return execution
            async def _fresh(self, *args):
                return True
        host = Host(service, "slack", "binding")
        provider = BridgeContext("binding", "slack", "team", "alice", "channel", "event",
            conversation_kind="direct", audience_ids=("alice",), audience_complete=True)
        path = Path(db.db_path).parent / "historical.png"
        path.write_bytes(b"synthetic image")
        media = BridgeAttachment("image", path.name, "image/png", path.stat().st_size,
                                 local_path=str(path), provider_attachment_id="history-file")
        reply = await host.send(BridgeMessage(provider, (BridgePart(text="Inspect the earlier image"),),
            history=(BridgeHistoryMessage("earlier-event", "another-speaker",
                (BridgePart(text="Quoted report"), BridgePart(attachment=media))),)))
        assert reply.parts == (BridgePart(text="Only the authoritative final answer"),)
        assert len(submitted) == 1 and len(submitted[0].attachments) == 1
        assert "another-speaker" in submitted[0].input and "Quoted report" in submitted[0].input
        assert str(path) not in submitted[0].input
        class ReadPolicy:
            async def authorize(self, actor, action, resource, **kwargs):
                return actor == execution and action == "artifact.read"
        ref = submitted[0].attachments[0]
        stored = await ArtifactRepository(db, ReadPolicy()).read(execution, artifact_id=ref["artifact_id"])
        assert stored.content == b"synthetic image" and stored.filename == "historical.png"


@test("channel_history_media", "quiet final metadata never strips or guesses legitimate prose")
async def t_final_answer_contract(ctx: TestContext) -> None:
    from openagent_server.bridges.terminal import terminal_answer, FINAL_UNAVAILABLE
    aggregate = "First I inspect tools. Then I work. Final response is not a delimiter."
    assert terminal_answer({"text": aggregate}) == {"text": FINAL_UNAVAILABLE}
    assert terminal_answer({"text": aggregate}, require_attested=False) == {"text": aggregate}
    exact = {"text": aggregate, "parts": [{"kind": "text", "text": aggregate}]}
    assert terminal_answer({"text": "different", "final_answer": exact}) is exact
    for malformed in ("last paragraph", {"text": 1}, {"parts": "text"}, {"surprise": True}):
        try:
            terminal_answer({"final_answer": malformed})
        except ValueError:
            pass
        else:
            raise AssertionError("Malformed final-answer metadata was accepted")


@test("channel_history_media", "gateway final media uses exact normal artifact route and current authorization")
async def t_gateway_final_media_reader(ctx: TestContext) -> None:
    from openagent_server.bridges.gateway_transport import GatewayBridgeTransport
    content = b"synthetic file"
    checks, reads, requests = [], [], []
    allowed = True
    class Bound:
        name = "slack"
        async def _prepare_delivery_context(self, context):
            checks.append(context)
            if not allowed:
                raise PermissionError("revoked")
    class Body:
        def __init__(self):
            self.offset = 0
        async def read(self, limit):
            data = content[self.offset:self.offset + limit]
            self.offset += len(data)
            reads.append(data)
            return data
    class Response:
        status = 200
        def __init__(self):
            self.content = Body()
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
    class HTTP:
        def get(self, url, **kwargs):
            requests.append((url, kwargs))
            return Response()
    transport = GatewayBridgeTransport(gateway_url="ws://127.0.0.1:1234/ws", gateway_token="synthetic")
    transport.bind_bridge(Bound())
    async def http():
        return HTTP()
    transport._audio_session = http
    reference = {"artifact_id": "art_fixture", "sha256": hashlib.sha256(content).hexdigest(),
        "size_bytes": len(content), "filename": "report.txt", "mime_type": "text/plain", "kind": "file",
        "url": "https://not-the-gateway.invalid/never-use-this"}
    parts = await transport._materialize_final_reply("context", {"text": "Final", "attachments": [reference]})
    assert requests[0][0] == "http://127.0.0.1:1234/api/artifacts/art_fixture/content"
    assert requests[0][1]["allow_redirects"] is False
    assert requests[0][1]["headers"] == {"Authorization": "Bearer synthetic"}
    assert len(checks) >= 5 and Path(parts[1].attachment.local_path).read_bytes() == content
    path = Path(parts[1].attachment.local_path)
    allowed = False
    try:
        await transport._materialize_final_reply("context", {"attachments": [reference]})
    except PermissionError:
        pass
    else:
        raise AssertionError("Revoked context read media")
    assert len(requests) == 1
    await transport.stop()
    assert not path.exists()


@test("channel_history_media", "real stream final metadata survives wire and collector without local paths")
async def t_final_answer_wire_and_collector(ctx: TestContext) -> None:
    from openagent_core.stream.collector import StreamCollector, fold_outbound_event
    from openagent_core.stream.events import OutTextFinal
    from openagent_client_transport.stream.wire import event_to_wire, wire_to_event
    reference = {"artifact_id": "art_fixture", "filename": "report.txt", "mime_type": "text/plain",
        "size_bytes": 3, "sha256": "a" * 64, "path": "/synthetic/private-path-not-for-wire"}
    final = {"text": "Final answer", "parts": [{"kind": "text", "text": "Final answer"},
        {"kind": "attachment", "attachment": reference}], "attachments": [reference]}
    event = OutTextFinal(session_id="session", text="Full narration and final answer",
                         final_answer=final)
    frame = event_to_wire(event, include_local_attachment_paths=True)
    assert frame["text"] == "Full narration and final answer"
    assert frame["final_answer"]["text"] == "Final answer"
    assert "path" not in frame["final_answer"]["attachments"][0]
    assert "path" not in frame["final_answer"]["parts"][1]["attachment"]
    assert reference["path"] == "/synthetic/private-path-not-for-wire"
    parsed = wire_to_event(frame)
    collector = StreamCollector()
    fold_outbound_event(collector, parsed)
    reply = collector.to_legacy_reply()
    assert reply["text"] == frame["text"]
    assert reply["final_answer"] == frame["final_answer"]
    # Text-only authoritative metadata must remain text-only. Inventing empty
    # parts would hide its text in consumers that correctly prefer ordered parts.
    text_only = OutTextFinal(session_id="session", text="Legacy aggregate",
                             final_answer={"text": "Text-only final"})
    assert event_to_wire(text_only)["final_answer"] == {"text": "Text-only final"}
