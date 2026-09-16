import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from openagent_core.audio import SynthesizedAudio
from openagent_core.core.on_behalf_context import OnBehalfIdentity
from openagent_server.gateway.server import Gateway


class Request(dict):
    def __init__(self, gateway, body=None, field=None):
        super().__init__(device_cert=object(), auth_kind='device_cert')
        self.app = {'gateway': gateway}
        self.body = body
        self.field = field
        self.query = {'lang': 'it'}

    async def json(self): return self.body
    async def multipart(self): return SimpleNamespace(next=AsyncMock(return_value=self.field))


class AudioAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.active = True
        async def active(*args): return self.active
        async def bind(request): return OnBehalfIdentity('network', 'user', 'alice', 'ab'*32, 'device_cert')
        self.gateway = SimpleNamespace(_request_device_still_authorized=active)
        self.gateway.runtime_service = SimpleNamespace(gateway=self.gateway,
            runtime=object(), agent=SimpleNamespace(name='worker', memory_db=object(), load_model_catalog=AsyncMock()),
            authorizer=SimpleNamespace(bind_request=bind),
            directory=SimpleNamespace(principal_active=active, owner_handle=AsyncMock(return_value='alice')))

    async def test_tts_preserves_provider_mime_and_rechecks_authorization(self):
        voice = SimpleNamespace(synthesize=AsyncMock(return_value=SynthesizedAudio(b'RIFFfixture', 'audio/wav')))
        with patch('openagent_server.audio_service.service_for_gateway', return_value=voice):
            response = await Gateway._handle_tts_synthesize(self.gateway, Request(self.gateway, {'text':'ciao'}))
            self.assertEqual(response.content_type, 'audio/wav')
            self.assertEqual(response.body, b'RIFFfixture')
            async def revoked(*args, **kwargs):
                self.active = False
                return SynthesizedAudio(b'private', 'audio/wav')
            voice.synthesize.side_effect = revoked
            with self.assertRaises(web.HTTPForbidden):
                await Gateway._handle_tts_synthesize(self.gateway, Request(self.gateway, {'text':'private'}))

    async def test_upload_filename_cannot_escape_and_temporary_file_is_removed(self):
        observed = []
        async def transcribe(path, **kwargs):
            observed.append(Path(path))
            self.assertEqual(Path(path).name, 'upload.wav')
            self.assertEqual(Path(path).read_bytes(), b'RIFFfixture')
            return 'ciao'
        field = SimpleNamespace(filename='../../escape.wav', read_chunk=AsyncMock(side_effect=[b'RIFFfixture', b'']))
        voice = SimpleNamespace(transcribe=transcribe)
        with patch('openagent_server.audio_service.service_for_gateway', return_value=voice):
            response = await Gateway._handle_stt_transcribe(self.gateway, Request(self.gateway, field=field))
        self.assertEqual(json.loads(response.text), {'text':'ciao'})
        self.assertFalse(observed[0].exists())
