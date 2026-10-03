# Voice notes in external channels

Telegram, Slack, Discord and WhatsApp bridges transcribe inbound voice notes before sending the turn through the shared stream. The original audio is stored as a durable attachment, and the transcript is sent as text to the selected chat model. A chat model therefore needs text input capability; it does not need native audio input merely because the user sent a voice note. OpenAgent Core handles that separation for every `source="stt"` turn.

The standalone server resolves STT in this order: an enabled configured STT provider, local `faster-whisper` when installed, then the legacy OpenAI Whisper API fallback when configured. If none can transcribe, the bridge sends a clear request to type the message. Regular audio attachments without a transcript still require a model configured for native audio input. Telegram's voice-note and audio-file message types both use the STT path.

The server constrains PyAV below 19 while using `faster-whisper` 1.2.1. PyAV 19 removed the `metadata_errors` argument that this STT implementation passes to `av.open()`. A fresh install must resolve a compatible PyAV release; upgrading PyAV independently can break local voice transcription.

To verify a deployment, send a real Telegram voice note, confirm that the agent answers its spoken content, and check that the original audio remains available in the session. A successful STT health check alone does not prove the chat-model handoff or Telegram reply.
