"""Slack MP4-container audio rendition fixtures; no provider or speech IO."""
from dataclasses import replace
import hashlib
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from openagent_channel_bridges.wire import ArtifactStore, to_wire
from test_provider_media import _Response, _Session, _Slack, _Transport


@pytest.mark.asyncio
@pytest.mark.parametrize("declared,actual", [(1883856,1079192),(1177046,667422),(50058,28370)])
@pytest.mark.parametrize("scope", ["current","historical"])
async def test_slack_m4a_rendition_uses_complete_http_representation_and_canonical_hash(declared, actual, scope):
    data=b'\x00\x00\x00\x18ftypM4A '+b'x'*(actual-12)
    file={"id":"Faudio","name":"audio_message.m4a","mimetype":"audio/mp4","size":declared,
          "url_private_download":"https://files.slack.com/files/Faudio"}
    class Host(_Transport):
        async def start(self):
            return replace(await super().start(),history_media=True,history_max_files=64)
        async def send(self, request, **kwargs):
            store=ArtifactStore();store.begin('r',max_files=64,max_input_bytes=64<<20)
            try:self.wire=to_wire(request,store,'r')
            finally:store.end('r')
            return await super().send(request,**kwargs)
    class Client:
        async def chat_postMessage(self,**kwargs):pass
        async def conversations_history(self,**kwargs):
            return {"messages":[{"ts":"5.0","user":"Uother","files":[file]}]}
    host=Host()
    bridge=_Slack('fixture-token',transport=host,binding_id='binding',allowed_users=['U1'],
                  listen_channels=['C1'],context_messages=1 if scope=='historical' else 0,live=False)
    bridge._account_id,bridge._bot_user_id='T1','BOT'
    session=_Session(_Response(chunks=[data[i:i+65536] for i in range(0,len(data),65536)],
                              headers={'Content-Length':str(len(data)),'Content-Type':'video/mp4'}))
    bridge._audio_session=AsyncMock(return_value=session)
    event={'type':'app_mention','channel':'C1','user':'U1','text':'<@BOT> inspect audio','ts':'10.0'}
    if scope=='current':event['files']=[file]
    await bridge.handle_event(event,Client(),account_id='T1',event_id='E1')
    assert len(host.requests)==1
    request=host.requests[0][0]
    parts=request.parts if scope=='current' else request.history[0].parts
    media=[part.attachment for part in parts if part.attachment]
    assert len(media)==1 and media[0].size_bytes==actual
    wire_parts=host.wire['parts'] if scope=='current' else host.wire['history'][0]['parts']
    attachment=next(part['attachment'] for part in wire_parts if part['attachment'])
    assert attachment['size_bytes']==actual and attachment['sha256']==hashlib.sha256(data).hexdigest()
    assert all(not Path(item.local_path).exists() for item in media)
    assert session.calls[0][2]['allow_redirects'] is False


@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['missing-length','truncated','over-budget','larger-than-metadata',
    'wrong-metadata-mime','wrong-http-mime','invalid-container','generic-file',
    'revoke-midstream','revoke-after-body','audience-change'])
async def test_slack_rendition_never_waives_completeness_identity_budget_or_authority(tmp_path, mode):
    from openagent_channel_bridges.contracts import BridgeContext
    host=_Transport()
    bridge=_Slack('fixture-token',transport=host,binding_id='binding',allowed_users=['U1'],listen_channels=['C1'],live=False)
    data=b'\x00\x00\x00\x18ftypM4A '+b'x'*52
    declared=128
    headers={'Content-Length':str(len(data)),'Content-Type':'video/mp4'}
    mime='audio/mp4';name='audio.m4a';limit=256
    if mode=='missing-length':headers.pop('Content-Length')
    if mode=='truncated':headers['Content-Length']=str(len(data)+1)
    if mode=='over-budget':limit=declared-1
    if mode=='larger-than-metadata':declared=len(data)-1
    if mode=='wrong-metadata-mime':mime='application/octet-stream'
    if mode=='wrong-http-mime':headers['Content-Type']='text/html'
    if mode=='invalid-container':data=b'<html>'+b'x'*(len(data)-6)
    if mode=='generic-file':name='report.bin'
    def change(index):
        if mode=='revoke-midstream' and index==1:host.allowed=False
        if mode=='revoke-after-body' and index==1:host.audience_allowed=False
        if mode=='audience-change' and index==1:host.new_member=True
    response=_Response(chunks=[data[:32],data[32:]],headers=headers,on_chunk=change)
    session=_Session(response);bridge._audio_session=AsyncMock(return_value=session)
    context=BridgeContext('binding','slack','T1','U1','C1','E1',conversation_kind='channel',
                          audience_ids=('U1',),audience_complete=True,audience_verified_at=1)
    async def run():
        return await bridge._download_file('https://files.slack.com/files/Faudio',str(tmp_path),name,
            declared_size=declared,declared_mime=mime,context=context,max_bytes=limit)
    if mode in {'revoke-midstream','revoke-after-body','audience-change'}:
        with pytest.raises(PermissionError):await run()
    else:
        outcome=await run()
        assert outcome.path is None
    assert list(tmp_path.iterdir())==[]
    assert host.requests==[]
