"""A voice note on a channel gets a text reply, never a synthesized audio file.

Bridges used to mirror the input modality: a voice note in produced a
text-to-speech audio attachment out. A voice note is just input; the reply is
the agent's text, and an audio file is sent only when the agent attaches one.
"""
import asyncio

from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import BridgeAttachment, BridgePart


class _Bridge(BaseBridge):
    def __init__(self):
        self._owned_artifacts = {}
        self.sent_text, self.sent_files, self.synthesized = [], [], []

    async def _authorize_outbound(self):
        return None

    async def _synthesize(self, text, *, context=None):
        self.synthesized.append(text)
        return BridgeAttachment("voice", "reply.mp3", "audio/mpeg", 1, local_path="/nonexistent/reply.mp3")

    async def synthesise_audio_attachment(self, text, *, context=None):
        self.synthesized.append(text)
        return "[VOICE:/nonexistent/reply.mp3]"

    async def send_response_text(self, target, text):
        self.sent_text.append(text)

    async def send_attachment(self, target, attachment):
        self.sent_files.append(attachment)

    def _platform_attachment(self, attachment):
        return attachment


def test_typed_parts_reply_to_a_voice_note_is_text_only():
    bridge = _Bridge()
    asyncio.run(bridge._deliver_typed_parts("chat", (BridgePart(text="Here is the answer."),),
                                            voice_detected=True))
    assert bridge.sent_text == ["Here is the answer."]
    assert bridge.sent_files == [] and bridge.synthesized == []


def test_legacy_text_reply_to_a_voice_note_is_not_synthesized():
    bridge = _Bridge()
    assert not hasattr(bridge, "maybe_prepend_voice_reply")
    assert bridge.synthesized == []
