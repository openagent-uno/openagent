from __future__ import annotations

import json
import time
from dataclasses import replace

import pytest

from openagent_host_tools import CapabilityHost, HostError, HostPaths
from openagent_tool_protocol.types import ServerManifest, ToolClassification, ToolManifest, ToolResult


class Native:
    manifest = ServerManifest('computer-control', 'test', '', tuple(
        ToolManifest(name, name, {}, ToolClassification.READ_ONLY if name in {'computer_list_apps','computer_app_policy'} else ToolClassification.MUTATING)
        for name in ('computer_list_apps','computer_launch_app','computer_app_policy','computer_audio_start','computer_audio_stop')
    ))

    def __init__(self):
        self.calls = []
        self.sequence = 0

    async def call(self, tool, args):
        self.calls.append((tool, args.copy()))
        self.sequence += 1
        if tool == 'computer_list_apps':
            value = {'apps': [{'app_ref': f'app-{self.sequence}', 'expires_in_ms': 600000}]}
        elif tool == 'computer_launch_app':
            value = {'app_ref': f'launched-{self.sequence}', 'expires_in_ms': 600000, 'pid': 12}
        elif tool == 'computer_audio_start':
            value = {'recording_id': f'recording-{self.sequence}', 'expires_in_ms': 60000}
        else:
            value = {'ok': True}
        return ToolResult.text(json.dumps(value))

    async def close(self):
        pass


@pytest.fixture
async def fixture(tmp_path):
    host = CapabilityHost(paths=HostPaths.discover(tmp_path / 'state'), builtin_names=())
    await host.start()
    await host.set_consent(True)
    native = Native()
    host._servers['computer-control'] = native
    host._inventory['computer-control'] = replace(native.manifest, available=True)
    host._health['computer-control'] = {'available': True, 'source': 'test'}
    try:
        yield host, native
    finally:
        await host.close()


async def discover(host, principal):
    result = await host.call('computer-control', 'computer_list_apps', {}, principal=principal)
    return json.loads(result.content[0]['text'])['apps'][0]['app_ref']


@pytest.mark.asyncio
async def test_app_discovery_launch_and_audio_are_bound_to_exact_principal(fixture):
    host, native = fixture
    owner = {'account_id':'a', 'client_instance_id':'device', 'browser_scope':'a'*64, 'generation':1}
    token = await discover(host, owner)
    for other in [dict(owner,account_id='b'), dict(owner,client_instance_id='other'), dict(owner,generation=2), dict(owner,browser_scope='b'*64)]:
        for tool in ('computer_launch_app','computer_app_policy','computer_audio_start'):
            with pytest.raises(HostError) as error:
                await host.call('computer-control', tool, {'app_ref':token, 'source':'system_output'}, principal=other)
            assert error.value.code == 'resource_owner_mismatch'
    assert len(native.calls) == 1
    launched = await host.call('computer-control', 'computer_launch_app', {'app_ref':token}, principal=owner)
    refreshed = json.loads(launched.content[0]['text'])['app_ref']
    assert refreshed != token
    await host.call('computer-control','computer_app_policy',{'app_ref':refreshed},principal=owner)
    start = await host.call('computer-control','computer_audio_start',{'app_ref':refreshed,'source':'system_output'},principal=owner,idempotency_key='start-once')
    recording = json.loads(start.content[0]['text'])['recording_id']
    replay = await host.call('computer-control','computer_audio_start',{'app_ref':refreshed,'source':'system_output'},principal=owner,idempotency_key='start-once')
    assert replay.meta['openagent/replayed'] is True
    assert sum(name == 'computer_audio_start' for name,_ in native.calls) == 1
    with pytest.raises(HostError):
        await host.call('computer-control','computer_audio_stop',{'recording_id':recording},principal=dict(owner,browser_scope='b'*64))
    await host.call('computer-control','computer_audio_stop',{'recording_id':recording},principal=owner)
    with pytest.raises(HostError):
        await host.call('computer-control','computer_audio_stop',{'recording_id':recording},principal=owner)


@pytest.mark.asyncio
async def test_native_resource_expiry_and_release_cleanup_do_not_return_audio(fixture):
    host, native = fixture
    token = await discover(host, 'owner')
    host._native_app_owners[token] = ('owner',time.monotonic()-1)
    with pytest.raises(HostError):
        await host.call('computer-control','computer_launch_app',{'app_ref':token},principal='owner')
    token = await discover(host, 'owner')
    started = await host.call('computer-control','computer_audio_start',{'source':'system_output','app_ref':token},principal='owner')
    recording = json.loads(started.content[0]['text'])['recording_id']
    await host.release_principal('owner')
    assert native.calls[-1] == ('computer_audio_stop',{'recording_id':recording,'return_audio':False})
    assert recording not in host._native_recording_owners
    assert token not in host._native_app_owners
    host._native_recording_owners['expired'] = ('owner',time.monotonic()-1)
    before = len(native.calls)
    with pytest.raises(HostError):
        await host.call('computer-control','computer_audio_stop',{'recording_id':'expired'},principal='owner')
    assert len(native.calls) == before


def test_native_provider_ttl_cannot_escape_caps_or_accept_boolean():
    owners = {}
    for ttl in (True,False,-1,0,600001,float('inf'),float('nan'),'1000',None):
        CapabilityHost._remember_native(owners,'bad','owner',ttl,600000)
    assert owners == {}
    CapabilityHost._remember_native(owners,'valid','owner',1000,600000)
    assert owners['valid'][0] == 'owner'
