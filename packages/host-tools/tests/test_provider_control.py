from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import sys
from dataclasses import replace

import pytest

from openagent_host_tools import CapabilityHost, HostError, HostPaths
from openagent_host_tools.chrome_pool import PerPrincipalMCPPool
from openagent_host_tools.config import PluginSpec
from openagent_host_tools.context import current_principal
from openagent_host_tools.control import dispatch_control
from openagent_host_tools.host import _principal_id
from openagent_host_tools.local_broker import LocalBrokerServer, LocalCapabilityClient
from openagent_host_tools.mcp_stdio import _operator_metadata
from openagent_host_tools.sidecars import AGENT_IN_CHROME_MANIFEST
from openagent_tool_protocol import ToolResult

DECISION = {'action': 'resume', 'tabId': 7, 'request_id': 'pending-owned'}
OWNER = {'client_instance_id': 'desktop-a', 'account_id': 'account-a', 'network_id': 'network-a'}

_FAKE = r'''
import hashlib,hmac,json,os,sys
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    if request['method']=='initialize': result={'protocolVersion':'2025-11-25','serverInfo':{'name':'agent-in-chrome','version':'3.0.0'},'capabilities':{'tools':{}}}
    elif request['method']=='tools/list': result={'tools':[{'name':name,'description':'test','inputSchema':{'type':'object'}} for name in ['browser_control','browser_permissions']]}
    elif request['method']=='tools/call':
        proof=request['params'].get('_meta',{}).get('openagent/browser-approval')
        valid=False
        if proof:
            text=json.dumps(proof['payload'],sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
            valid=hmac.compare_digest(hmac.new(os.environ['OPENAGENT_BROWSER_CONTROL_SECRET'].encode(),text,hashlib.sha256).hexdigest(),proof['signature'])
        result={'content':[], 'structuredContent':{'proof':proof,'valid':valid,'arguments':request['params']['arguments']}}
    else: result={}
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
'''


def test_operator_metadata_has_exact_canonical_shape_and_no_caller_proof():
    metadata = _operator_metadata('browser_control', DECISION, 'owned-secret')
    proof = metadata['openagent/browser-approval']
    payload = proof['payload']
    assert set(payload) == {'version','action','browser_id','tab_id','request_id','nonce','expires_at_ms','origin','permissions'}
    assert payload['origin'] is None and payload['permissions'] == []
    assert payload['browser_id'] == 'dedicated' and payload['tab_id'] == 7
    canonical = json.dumps(payload,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
    assert proof['signature'] == hmac.new(b'owned-secret',canonical,hashlib.sha256).hexdigest()
    assert _operator_metadata('browser_control', DECISION, 'owned-secret') != metadata
    grant = _operator_metadata('browser_permissions', dict(DECISION, action='grant', origin='https://example.test', permissions=['notifications','camera']), 'owned-secret')
    assert grant['openagent/browser-approval']['payload']['permissions'] == ['camera','notifications']


@pytest.mark.parametrize('tool,args', [
    ('browser_action', DECISION), ('browser_control', dict(DECISION, action={})),
    ('browser_control', dict(DECISION, _meta={'forged':True})),
    ('browser_control', dict(DECISION, tabId=True)),
    ('browser_control', dict(DECISION, permissions=None)),
    ('browser_control', dict(DECISION, origin='https://evil.test')),
    ('browser_permissions', dict(DECISION, action='grant', origin='https://example.test/path', permissions=['camera'])),
    ('browser_permissions', dict(DECISION, action='grant', origin='https://example.test', permissions=['camera','camera'])),
])
def test_operator_metadata_rejects_untrusted_or_ambiguous_decisions(tool,args):
    with pytest.raises(HostError) as error: _operator_metadata(tool,args,'owned-secret')
    assert error.value.code == 'invalid_provider_control'


@pytest.mark.asyncio
async def test_per_principal_public_mcp_transport_signs_only_operator_path(tmp_path):
    script=tmp_path/'mcp.py'; script.write_text(_FAKE)
    pool=PerPrincipalMCPPool(PluginSpec('agent-in-chrome',(sys.executable,str(script))),placeholder=AGENT_IN_CHROME_MANIFEST,data_root=tmp_path/'profiles')
    owner=_principal_id(OWNER)
    try:
        with pytest.raises(HostError): await pool.provider_control('browser_control',DECISION,principal=owner)
        assert not pool._instances  # operator decisions never create or choose a browser
        token=current_principal.set(owner)
        try: ordinary=await pool.call('browser_control',DECISION)
        finally: current_principal.reset(token)
        assert ordinary.structured_content['proof'] is None
        result=await pool.provider_control('browser_control',DECISION,principal=owner)
        assert result.structured_content['valid'] is True
        proof=result.structured_content['proof']
        assert proof['payload']['request_id'] == DECISION['request_id']
        other=_principal_id(dict(OWNER,network_id='network-other'))
        with pytest.raises(HostError): await pool.provider_control('browser_control',DECISION,principal=other)
        with pytest.raises(HostError): await pool.provider_control('browser_control',dict(DECISION,_meta=proof),principal=owner)
        await pool.release_principal(owner)
        assert not pool._control_secrets
        with pytest.raises(HostError): await pool.provider_control('browser_control',DECISION,principal=owner)
    finally: await pool.close()


class ControlledProvider:
    manifest = AGENT_IN_CHROME_MANIFEST
    def __init__(self): self.seen=[]; self.entered=asyncio.Event(); self.hold=False
    async def provider_control(self,tool,args,*,principal):
        self.seen.append((tool,args,principal)); self.entered.set()
        if self.hold: await asyncio.Event().wait()
        return ToolResult.text('operator-result')
    async def close(self): pass


@pytest.mark.asyncio
async def test_host_control_is_explicit_consent_bound_and_revocation_drains(tmp_path):
    host=CapabilityHost(paths=HostPaths.discover(tmp_path/'state'),builtin_names=())
    await host.start(); provider=ControlledProvider(); host._servers['agent-in-chrome']=provider
    try:
        missing=await dispatch_control(host,{'id':'missing','type':'provider_control','server':'agent-in-chrome','tool':'browser_control','args':DECISION})
        assert missing.frame['error']['code']=='invalid_request'
        denied=await dispatch_control(host,{'id':'denied','type':'provider_control','principal':OWNER,'server':'agent-in-chrome','tool':'browser_control','args':DECISION})
        assert denied.frame['error']['code']=='consent_required' and not provider.seen
        await host.set_consent(True)
        with pytest.raises(HostError): await host.provider_control('shell','browser_control',DECISION,principal=OWNER,call_id='bad')
        ok=await dispatch_control(host,{'id':'decision','type':'provider_control','principal':OWNER,'server':'agent-in-chrome','tool':'browser_control','args':DECISION})
        assert ok.frame['ok'] is True and provider.seen[-1][2]==_principal_id(OWNER)
        provider.hold=True; provider.entered.clear()
        task=asyncio.create_task(host.provider_control('agent-in-chrome','browser_control',DECISION,principal=OWNER,call_id='held'))
        await provider.entered.wait()
        with pytest.raises(HostError) as duplicate:
            await host.provider_control('agent-in-chrome','browser_control',DECISION,principal=OWNER,call_id='held')
        assert duplicate.value.code=='duplicate_call'
        await asyncio.wait_for(host.release_principal(OWNER),2)
        with pytest.raises(HostError) as cancelled: await task
        assert cancelled.value.code=='provider_control_indeterminate'
        assert not host._active and not host._active_mutating and not host._active_done
        assert len(provider.seen)==2  # no retry of an uncertain operator mutation
    finally: await host.close()


@pytest.mark.asyncio
async def test_local_broker_high_level_operator_roundtrip_requires_explicit_owner(tmp_path):
    paths=HostPaths.discover(tmp_path/'broker')
    server=LocalBrokerServer(paths)
    # Keep this fixture wholly local and independent of optional installed sidecars.
    server.host=CapabilityHost(paths=paths,builtin_names=())
    provider=ControlledProvider()
    task=asyncio.create_task(server.run())
    client=LocalCapabilityClient(paths)
    try:
        for _ in range(200):
            if server.unix_socket_path.exists(): break
            await asyncio.sleep(.01)
        await client.start(); await client.set_consent(True)
        server.host._servers['agent-in-chrome']=provider
        result=await client.provider_control('agent-in-chrome','browser_control',DECISION,principal=OWNER)
        assert result.content[0]['text']=='operator-result'
        assert provider.seen[0][2]==_principal_id(OWNER)
        await client.release_principal(OWNER)
    finally:
        await client.close(); task.cancel(); await asyncio.gather(task,return_exceptions=True)


@pytest.mark.asyncio
async def test_browser_scope_isolates_same_account_sessions_without_changing_ordinary_account_reuse(tmp_path):
    script=tmp_path/'mcp.py'; script.write_text(_FAKE)
    pool=PerPrincipalMCPPool(PluginSpec('agent-in-chrome',(sys.executable,str(script))),placeholder=AGENT_IN_CHROME_MANIFEST,data_root=tmp_path/'profiles')
    first=_principal_id(dict(OWNER,browser_scope='a'*64))
    second=_principal_id(dict(OWNER,browser_scope='b'*64))
    try:
        for principal in (first,second):
            token=current_principal.set(principal)
            try: await pool.call('browser_control',DECISION)
            finally: current_principal.reset(token)
        assert len(pool._instances)==2 and len(set(pool._control_secrets.values()))==2
        a=await pool.provider_control('browser_control',DECISION,principal=first)
        b=await pool.provider_control('browser_control',DECISION,principal=second)
        assert a.structured_content['valid'] and b.structured_content['valid']
        await pool.release_principal(first)
        assert len(pool._instances)==1
        assert (await pool.provider_control('browser_control',DECISION,principal=second)).structured_content['valid']
        with pytest.raises(HostError): _principal_id(dict(OWNER,browser_scope='forged-readable-selector'))
    finally: await pool.close()
