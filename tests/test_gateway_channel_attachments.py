"""Gateway wire references must reach every channel delivery mode through CAS."""
from hashlib import sha256
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from openagent_channel_bridges.contracts import BridgeContext, BridgeMessage, BridgePart
from openagent_core.stream.collector import StreamCollector, fold_outbound_event
from openagent_core.stream.events import OutTextFinal
from openagent_client_transport.stream.wire import event_to_wire, wire_to_event
from openagent_server.bridges.gateway_transport import GatewayBridgeTransport


@pytest.mark.parametrize('provider', ['telegram', 'whatsapp', 'slack', 'discord'])
@pytest.mark.parametrize('mode', ['live', 'final', 'quiet'])
async def test_wire_artifacts_materialize_in_all_delivery_modes(tmp_path, mode, provider):
    bodies = {'art_image': b'synthetic image bytes', 'art_file': b'name,value\nA,1\n'}
    requests = []
    allowed = True
    context = BridgeContext(provider, provider, 'bot', 'owner', 'owner', 'event', conversation_kind='direct')

    class Bound:
        name = provider
        binding_id = provider
        _delivery_mode = mode
        async def _prepare_delivery_context(self, value):
            assert value == context
            if not allowed:
                raise PermissionError('revoked')
            return value

    async def content(request):
        requests.append((request.path, request.headers.get('Authorization')))
        assert request.headers.get('Authorization') == 'Bearer fixture'
        return web.Response(body=bodies[request.match_info['id']])

    app = web.Application()
    app.router.add_get('/api/artifacts/{id}/content', content)
    async with TestServer(app) as server:
        transport = GatewayBridgeTransport(gateway_url=str(server.make_url('/ws')).replace('http:', 'ws:'), gateway_token='fixture')
        transport.bind_bridge(Bound())
        refs = [dict(artifact_id=key, kind='image' if key == 'art_image' else 'file', filename=key+'.bin',
                     mime_type='image/png' if key == 'art_image' else 'text/csv', size_bytes=len(body), sha256=sha256(body).hexdigest(),
                     path='/untrusted/never-open', url='https://untrusted.invalid/never-fetch') for key, body in bodies.items()]
        final = {'text': 'Final answer', 'attachments': refs}
        event = OutTextFinal(session_id='session', text='Narration and final answer', attachments=tuple(refs), final_answer=final)
        collector = StreamCollector()
        fold_outbound_event(collector, wire_to_event(event_to_wire(event)))
        response = collector.to_legacy_reply()
        assert all('path' not in ref for ref in response['attachments'])
        async def generate(*args, **kwargs):
            return response
        transport._legacy_send_message = generate
        try:
            reply = await transport.send(BridgeMessage(context, (BridgePart(text='send assets'),)))
            attachments = [part.attachment for part in reply.parts if part.attachment is not None]
            assert len(attachments) == 2
            assert [Path(att.local_path).read_bytes() for att in attachments] == list(bodies.values())
            assert [att.kind for att in attachments] == ['image', 'file']
            assert all(att.owned for att in attachments)
            assert requests == [('/api/artifacts/'+key+'/content', 'Bearer fixture') for key in bodies]
            assert reply.parts[0].text == ('Final answer' if mode == 'quiet' else 'Narration and final answer')
            paths = [Path(att.local_path) for att in attachments]
            allowed = False
            with pytest.raises(PermissionError):
                await transport.send(BridgeMessage(context, (BridgePart(text='send assets again'),)))
            assert len(requests) == 2
        finally:
            await transport.stop()
        assert all(not path.exists() for path in paths)


@pytest.mark.parametrize('mode', ['live', 'final'])
@pytest.mark.parametrize('failure', ['missing', 'digest'])
async def test_canonical_artifact_failure_does_not_fall_back_to_supplied_path(tmp_path, mode, failure):
    local = tmp_path/'private.txt'
    local.write_text('must never be sent')
    context = BridgeContext('telegram', 'telegram', 'bot', 'owner', 'owner', 'event', conversation_kind='direct')
    class Bound:
        name = 'telegram'
        binding_id = 'telegram'
        _delivery_mode = mode
        async def _prepare_delivery_context(self, value):
            return value
    async def content(request):
        return web.Response(status=404 if failure == 'missing' else 200, body=b'bad')
    app = web.Application()
    app.router.add_get('/api/artifacts/{id}/content', content)
    async with TestServer(app) as server:
        transport = GatewayBridgeTransport(gateway_url=str(server.make_url('/ws')).replace('http:', 'ws:'))
        transport.bind_bridge(Bound())
        ref = dict(artifact_id='art_fixture', kind='file', filename='private.txt', mime_type='text/plain',
                   size_bytes=3, sha256='a'*64, path=str(local))
        async def generate(*args, **kwargs):
            return dict(type='response', text='Here', attachments=[ref])
        transport._legacy_send_message = generate
        try:
            with pytest.raises((RuntimeError, ValueError)):
                await transport.send(BridgeMessage(context, (BridgePart(text='send assets'),)))
            assert not transport._delivery_files
            assert local.read_text() == 'must never be sent'
        finally:
            await transport.stop()


@pytest.mark.parametrize('replacement', [None, 'file', 'symlink'])
async def test_standalone_provider_releases_owned_cas_files_without_touching_replacements(tmp_path, replacement):
    import os
    from openagent_server.bridges.base import BaseBridge
    from openagent_channel_bridges.contracts import BridgeAttachment
    class Provider(BaseBridge):
        name = 'telegram'
    transport = GatewayBridgeTransport()
    provider = Provider(transport=transport, binding_id='telegram')
    path = tmp_path/'oa-channel-final-fixture'
    path.write_bytes(b'owned delivery bytes')
    info = path.stat()
    transport._delivery_files[path] = (info.st_dev, info.st_ino)
    attachment = BridgeAttachment('file', 'report.txt', 'text/plain', path.stat().st_size, local_path=str(path), owned=True)
    provider._platform_attachment(attachment)
    held = None
    try:
        if replacement:
            held = path.open('rb')  # Keep the old inode alive, avoiding filesystem reuse.
            path.unlink()
            if replacement == 'file':
                path.write_text('unrelated replacement')
            else:
                target = tmp_path/'private.txt';target.write_text('private');path.symlink_to(target)
        provider._cleanup_owned_temp_artifact(str(path))
        assert not provider._owned_artifacts
        assert not transport._delivery_files
        if replacement == 'file':
            assert path.read_text() == 'unrelated replacement'
        elif replacement == 'symlink':
            assert path.is_symlink() and path.read_text() == 'private'
        else:
            assert not path.exists()
    finally:
        if held is not None:held.close()
        await transport.stop()
