"""Standalone audio policy and local adapters over the optional public service."""
from pathlib import Path
import sys

from aiohttp import web
from openagent_core.audio import VoiceService, SynthesizedAudio
from openagent_core.runtime import runtime_scope
from openagent_server.provider_management import for_request as management_for_request


class LocalAudioFallback:
    def __init__(self, runtime):
        from openagent_core.voice.stt_base import WhisperLocalSTT
        from openagent_core.voice.tts_base import LocalPiperTTS
        self.runtime = runtime
        self.stt = WhisperLocalSTT()
        self.tts = LocalPiperTTS()

    async def transcribe(self, path: Path, *, language=None):
        with runtime_scope(self.runtime):
            return await self.stt.transcribe_file(str(path), language=language)

    async def synthesize(self, text, *, language=None):
        with runtime_scope(self.runtime):
            data = await self.tts.synthesize_full(text, language=language)
        return SynthesizedAudio(data, self.tts.audio_format[1]) if data else None


def service_for_gateway(gateway):
    service = getattr(gateway, "runtime_service", None)
    if service is None or service.runtime is None:
        raise web.HTTPServiceUnavailable(text="Audio is not ready")
    settings = service.agent.config.get("voice") or {}
    fallback = LocalAudioFallback(service.runtime) if settings.get("local_fallback", True) else None
    worker = (sys.executable, "_audio-worker") if getattr(sys, "frozen", False) else None
    return VoiceService(service.agent.memory_db, fallback=fallback, worker_command=worker,
        timeout_seconds=float(settings.get("timeout_seconds", 120)))


async def for_request(request):
    admin, context = await management_for_request(request)
    try:
        await admin.authorize(context, "model.read")
    except PermissionError:
        raise web.HTTPForbidden(text="Audio use is not authorized") from None
    return service_for_gateway(request.app["gateway"]), admin, context
