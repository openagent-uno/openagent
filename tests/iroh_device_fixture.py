"""Real local tool bundle over the authenticated Iroh gateway capability socket.

All consent, ledgers, files and processes belong to a supplied temporary
workspace. No user profile, external sidecar or ambient credential is loaded.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path

import aiohttp
from openagent_host_tools import CapabilityBridge, CapabilityHost, HostPaths


class IrohDeviceFixture:
    def __init__(self, *, http, base_url: str, workspace: Path, device_id: str,
                 network_id: str, client_instance_id: str, generation: int = 1):
        self.http = http
        self.base_url = base_url
        self.workspace = workspace.resolve()
        self.device_id = device_id
        self.network_id = network_id
        self.client_instance_id = client_instance_id
        self.generation = generation
        self.frames = []
        self.calls = []
        self.responses = []
        self.socket = None
        self.bridge = None
        self.listener = None
        self.heartbeat = None
        self.closed = False
        self._heartbeat_ack = asyncio.Event()
        self.environment = {'PATH': os.defpath, 'HOME': str(self.workspace), 'LANG': 'C.UTF-8'}
        self.host = CapabilityHost(paths=HostPaths(self.workspace/'host-state'), cwd=self.workspace,
            builtin_names=('filesystem','editor','shell'), process_environment=self.environment)

    @property
    def shell_arguments(self):
        return {'command': "printf 'OPENAGENT_DEVICE_FIXTURE\\n' > device-marker.txt; pwd",
                'cwd': str(self.workspace), 'timeout': 5000}

    @property
    def editor_arguments(self):
        return {'file_path': str(self.workspace/'editable.txt'),
                'old_string': 'before fixture', 'new_string': 'after fixture'}

    @property
    def filesystem_arguments(self):
        return {'path': str(self.workspace/'editable.txt')}

    @property
    def marker(self):
        return self.workspace/'device-marker.txt'

    async def start(self):
        self.workspace.mkdir(parents=True, exist_ok=True)
        (self.workspace/'editable.txt').write_text('before fixture\n')
        await self.host.start()
        await self.host.set_consent(True)
        self.socket = await self.http.ws_connect(self.base_url+'/ws/capabilities')
        async def send(frame):
            self.frames.append(frame)
            if frame.get('type') in {'client_tool_result','client_tool_error'}:
                self.responses.append(frame)
            await self.socket.send_json(frame)
        self.bridge = CapabilityBridge(self.host, client_instance_id=self.client_instance_id,
            generation=self.generation, send_json=send, device_label='Temporary device '+self.client_instance_id,
            trusted_account_id=self.network_id, trusted_network_id=self.network_id,
            trusted_device_id=self.device_id)
        await self.bridge.hello()
        ack = await self.socket.receive_json(timeout=10)
        expected = {'type':'capability_hello_ack','accepted':True,
                    'protocol':'client-capabilities/1','device_id':self.device_id,
                    'account_id':self.network_id,'client_instance_id':self.client_instance_id,
                    'generation':self.generation}
        if any(ack.get(key) != value for key,value in expected.items()):
            raise AssertionError(('Capability registration identity mismatch',ack,expected))
        self.bridge.activate_events()
        self.listener = asyncio.create_task(self._listen(), name='fixture-device-reader')
        self.heartbeat = asyncio.create_task(self._heartbeat(), name='fixture-device-heartbeat')
        return self

    async def _listen(self):
        async for message in self.socket:
            if message.type == aiohttp.WSMsgType.TEXT:
                frame = json.loads(message.data)
                if frame.get('type') == 'capability_heartbeat_ack':
                    self._heartbeat_ack.set()
                if frame.get('type') == 'client_tool_call':
                    self.calls.append(frame)
                await self.bridge.handle(frame)
            elif message.type == aiohttp.WSMsgType.ERROR:
                raise RuntimeError('Capability fixture transport failed') from self.socket.exception()

    async def _heartbeat(self):
        while True:
            await asyncio.sleep(10)
            await self.bridge.heartbeat()

    async def set_consent(self, enabled: bool):
        await self.host.set_consent(enabled)
        # Catalogue update is sent explicitly so the fixture can wait for a
        # heartbeat round trip before exercising a revoked discovery result.
        self._heartbeat_ack.clear()
        await self.bridge.catalog_update()
        await self.bridge.heartbeat()
        await asyncio.wait_for(self._heartbeat_ack.wait(), 10)

    def verify_shell_effect(self):
        assert self.marker.read_text() == 'OPENAGENT_DEVICE_FIXTURE\n'
        shell_calls = [frame for frame in self.calls if frame['server']=='shell' and frame['tool']=='shell_exec']
        assert len(shell_calls) == 1, shell_calls
        call = shell_calls[0]
        assert call['args'] == self.shell_arguments, call
        assert call['generation'] == self.generation
        assert call['account_id'] == self.network_id
        assert call['network_id'] == self.network_id
        assert any(frame.get('call_id') == call['call_id'] for frame in self.responses)

    def verify_file_effect(self):
        assert (self.workspace/'editable.txt').read_text() == 'after fixture\n'
        for source, name, arguments in (
            ('editor', 'edit', self.editor_arguments),
            ('filesystem', 'read_text_file', self.filesystem_arguments),
        ):
            calls = [frame for frame in self.calls if frame['server']==source and frame['tool']==name]
            assert len(calls)==1, calls
            assert calls[0]['args']==arguments, calls[0]
            assert calls[0]['generation']==self.generation
            assert calls[0]['account_id']==self.network_id

    async def close(self):
        if self.closed:
            return
        self.closed = True
        tasks = [task for task in (self.listener,self.heartbeat) if task is not None]
        for task in tasks:
            task.cancel()
        errors = []
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            errors = [result for result in results if isinstance(result, Exception)]
        try:
            if self.bridge is not None:
                await self.bridge.close()
            if self.socket is not None:
                await self.socket.close()
        finally:
            await self.host.close()
        if errors:
            raise ExceptionGroup("Capability fixture background failure", errors)


@asynccontextmanager
async def device_fixture(**kwargs):
    fixture = IrohDeviceFixture(**kwargs)
    try:
        yield await fixture.start()
    finally:
        await fixture.close()
