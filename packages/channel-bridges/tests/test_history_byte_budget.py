"""Synthetic long speech histories: no provider/model calls or account data."""
from dataclasses import replace
from pathlib import Path
import pytest
from openagent_channel_bridges.contracts import BridgeCapabilities, BridgeHistoryMessage, BridgeMessage, BridgePart
from openagent_channel_bridges.history import bound_history, history_size_bytes
from test_quiet_history_media import Host, SlackClient, slack, media_files

class SpeechHost(Host):
    def __init__(self, budget=None, *, revoke=False):
        super().__init__(history_max_files=64)
        self.budget, self.revoke = budget, revoke
    async def start(self):
        value = await super().start()
        return value if self.budget is None else replace(value, history_max_bytes=self.budget)
    async def transcribe(self, context, attachment):
        self.speech.append(attachment.provider_attachment_id)
        if self.revoke and len(self.speech) == 2:
            self.allowed = False
        return "Synthetic speech. " * 260

class LongHistory(SlackClient):
    async def conversations_history(self, **kwargs):
        rows = []
        for number in range(187, 0, -1):
            value = {"ts":str(number)+".0", "user":"bob", "text":"context " * 15}
            if number <= 19:
                value["files"] = [{**media_files()[2], "id":"voice-"+str(number)}]
            rows.append(value)
        page = rows[:100] if not kwargs.get("cursor") else rows[100:]
        return {"messages":page, "has_more":len(page)==100,
                "response_metadata":{"next_cursor":"next" if len(page)==100 else ""}}

@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [None, 262144])
async def test_19_full_transcripts_never_silently_drop_earliest_reports(budget):
    host=SpeechHost(budget);client=LongHistory([]);downloads=[]
    bridge=slack(host,client,downloads);bridge.context_messages=200
    staged=[]; original=bridge._download_file
    async def download(*args,**kwargs):
        value=await original(*args,**kwargs);staged.append(value.path);return value
    bridge._download_file=download
    await bridge.handle_event({"type":"app_mention","channel":"C","user":"alice",
        "text":"<@BOT> inspect the reports", "ts":"500.0"},client,account_id="T",event_id="500.0")
    assert len(host.speech)==19 and len(downloads)==19
    assert len(client.posts)==2
    if budget is None:
        assert host.requests==[]
        assert "history" in client.posts[-1]["text"] and "No agent task was started" in client.posts[-1]["text"]
    else:
        assert len(host.requests)==1
        records=host.requests[0].history
        assert len(records)==187 and records[0].event_id=="1.0"
        assert 65536 < history_size_bytes(records) <= 262144
        assert sum(part.attachment is not None for row in records for part in row.parts)==19
        assert sum((part.text or "").startswith("Audio transcript") for row in records for part in row.parts)==19
    assert len(staged)==19 and all(not Path(path).exists() for path in staged)

@pytest.mark.parametrize("bad", [True, False, 65535, 262145, 2, 1.5, "262144", None])
def test_history_byte_cap_rejects_nonintegers_and_out_of_bounds(bad):
    with pytest.raises(ValueError): BridgeCapabilities(history_max_bytes=bad)

def test_byte_overflow_is_explicit_instead_of_omitting_complete_records():
    rows=(BridgeHistoryMessage("1","actor",(BridgePart(text="€"*40000),)),)
    with pytest.raises(RuntimeError,match="history"):
        bound_history(rows)
    assert bound_history(rows,max_bytes=262144)==rows

@pytest.mark.asyncio
async def test_negotiated_history_still_denies_mid_speech_revocation():
    host=SpeechHost(262144,revoke=True);client=LongHistory([]);downloads=[]
    bridge=slack(host,client,downloads);bridge.context_messages=200
    await bridge.handle_event({"type":"app_mention","channel":"C","user":"alice",
        "text":"<@BOT> inspect reports", "ts":"500.0"},client,account_id="T",event_id="500.0")
    assert host.requests==[] and len(client.posts)==1

@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [None,262144])
async def test_ipc_start_cap_is_enforced_before_any_large_send(budget):
    import asyncio
    from test_stdio import fixture_transport, frame, message
    from openagent_channel_bridges.wire import WireError
    transport,queue=fixture_transport();start=asyncio.create_task(transport.start())
    request=await queue.get()
    await transport.receive(frame("result",request["request_id"],result={} if budget is None else {"history_max_bytes":budget}))
    capabilities=await start
    assert capabilities.history_max_bytes==(65536 if budget is None else budget)
    rows=(BridgeHistoryMessage("old","bob",(BridgePart(text="€"*40000),)),)
    value=replace(message(),history=rows)
    try:
        if budget is None:
            with pytest.raises(WireError,match="history_byte_limit"): await transport.send(value)
            assert queue.empty() and not transport._pending and not transport.artifacts._scopes
        else:
            task=asyncio.create_task(transport.send(value));request=await queue.get()
            assert len(request["params"]["history"])==1
            await transport.receive(frame("result",request["request_id"],result={"parts":[{"text":"final"}]}))
            assert (await task).parts[0].text=="final"
    finally: transport.close()

@pytest.mark.asyncio
async def test_parts_overflow_before_download_and_after_transcription_is_explicit(tmp_path):
    from test_quiet_history_media import Capture,context
    from openagent_channel_bridges.contracts import BridgeAttachment
    from openagent_channel_bridges.history_media import prepare_history_media,HistoryUnavailable
    host=SpeechHost(262144);bridge=Capture(host)
    path=tmp_path/'voice.ogg';path.write_bytes(b'fixture')
    attachment=BridgeAttachment('voice',path.name,'audio/ogg',7,provider_attachment_id='voice')
    async def load(row,item,remaining): return replace(item,local_path=str(path))
    rows=(BridgeHistoryMessage('old','bob',tuple(BridgePart(text='x') for _ in range(256))),)
    with pytest.raises(HistoryUnavailable,match='256-part'):
        await prepare_history_media(bridge,rows,context(),load)
    assert host.speech==[]
    rows=(BridgeHistoryMessage('old','bob',tuple([BridgePart(text='x') for _ in range(254)]+[BridgePart(attachment=attachment)])),)
    with pytest.raises(HistoryUnavailable,match='256-part'):
        await prepare_history_media(bridge,rows,context(),load)
    assert len(host.speech)==1 and path.read_bytes()==b'fixture'

@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [65536,262144])
async def test_base_transport_cannot_bypass_negotiated_history_byte_limit(budget):
    from test_quiet_history_media import Capture,context
    host=SpeechHost(budget);bridge=Capture(host)
    rows=(BridgeHistoryMessage('old','bob',(BridgePart(text='€'*40000),)),)
    if budget==65536:
        with pytest.raises(RuntimeError,match='history'):
            await bridge.send_message('current',context=context(),history=rows)
        assert host.requests==[]
    else:
        await bridge.send_message('current',context=context(),history=rows)
        assert len(host.requests)==1 and host.requests[0].history==rows

@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [65536,262144])
async def test_discord_uses_negotiated_cap_before_and_after_history(budget):
    from test_provider_context import ProviderContextTests,discord_message
    case=ProviderContextTests();bridge,host,channel,_=case.discord()
    async def start(): return BridgeCapabilities(history_max_bytes=budget)
    host.start=start
    trigger=discord_message(channel,50)
    channel.messages=[discord_message(channel,number,text='界'*10000) for number in [49,48,47,46]]
    if budget==65536:
        with pytest.raises(RuntimeError,match='history'):
            await bridge._history(trigger,bridge._bridge_context(trigger))
    else:
        result=await bridge._history(trigger,bridge._bridge_context(trigger))
        assert [row.event_id for row in result]==['46','47','48','49']
        assert 65536 < history_size_bytes(result) <= budget
    assert host.requests==[]
