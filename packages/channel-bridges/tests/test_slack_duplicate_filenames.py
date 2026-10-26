"""Real download/staging/wire path; only Slack HTTP responses are scripted."""
import hashlib
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from openagent_channel_bridges.wire import ArtifactStore, to_wire
from test_provider_media import _Response, _Slack, _Transport


@pytest.mark.asyncio
async def test_slack_eight_attachments_retain_distinct_bytes_despite_shared_url_basename():
    files = []
    bodies = {}
    for index in range(8):
        name = "presentation.pdf" if index == 0 else "image.png"
        url = f"https://files.slack.com/files-pri/T1-F{index}/download/{name}"
        body = f"distinct attachment {index}".encode()
        bodies[url] = body
        files.append({"id": f"F{index}", "name": name, "size": len(body),
            "mimetype": "application/pdf" if index == 0 else "image/png",
            "url_private_download": url})

    class HTTP:
        def get(self, url, **kwargs):
            assert kwargs["allow_redirects"] is False
            data = bodies[url]
            return _Response(chunks=[data], headers={"Content-Length": str(len(data))})

    class Host(_Transport):
        async def send(self, request, **kwargs):
            store = ArtifactStore()
            store.begin("r", max_files=64, max_input_bytes=64 << 20)
            try:
                self.wire = to_wire(request, store, "r")
            finally:
                store.end("r")
            return await super().send(request, **kwargs)

    class Client:
        def __init__(self): self.posts = []
        async def chat_postMessage(self, **kwargs): self.posts.append(kwargs)

    host, client = Host(), Client()
    bridge = _Slack("fixture-token", transport=host, binding_id="binding",
        allowed_users=["U1"], listen_channels=["C1"], context_messages=0, live=False)
    bridge._account_id, bridge._bot_user_id = "T1", "BOT"
    bridge._audio_session = AsyncMock(return_value=HTTP())
    await bridge.handle_event({"type": "app_mention", "channel": "C1", "user": "U1",
        "text": "<@BOT> update these slides", "ts": "10.0", "files": files},
        client, account_id="T1", event_id="E1")
    assert len(host.requests) == 1
    request, retained = host.requests[0]
    media = [part.attachment for part in request.parts if part.attachment]
    assert len(media) == 8
    assert retained == tuple(bodies[file["url_private_download"]] for file in files)
    assert [item.filename for item in media] == [file["name"] for file in files]
    assert [item.provider_attachment_id for item in media] == [file["id"] for file in files]
    assert len({item.local_path for item in media}) == 8
    wire = [part["attachment"] for part in host.wire["parts"] if part["attachment"]]
    assert [item["sha256"] for item in wire] == [hashlib.sha256(body).hexdigest() for body in retained]
    assert not any("Impossibile scaricare" in str(post) for post in client.posts)
    assert all(not Path(item.local_path).exists() for item in media)
