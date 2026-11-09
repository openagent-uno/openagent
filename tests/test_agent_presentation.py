"""Profile ownership, media normalization, and synchronization ordering."""
import base64
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import yaml
from PIL import Image

from openagent_product_config.agent_identity import (
    AgentIdentityConflict,
    AgentIdentityInputError,
    AgentIdentityPermissionError,
    AgentIdentityService,
)
from openagent_server.channel_presentation import ChannelPresentationSync


def thumbnail():
    source = io.BytesIO()
    Image.new("RGBA", (120, 80), (255, 100, 0, 128)).save(source, "PNG")
    return "data:image/png;base64," + base64.b64encode(source.getvalue()).decode()


@pytest.mark.asyncio
async def test_thumbnail_uses_owner_revision_and_is_removed_without_changing_persona(tmp_path):
    path = tmp_path / "openagent.yaml"
    path.write_text(yaml.safe_dump({"name": "Example", "system_prompt": "Private persona"}))
    owner = SimpleNamespace(handle="owner")
    callback = SimpleNamespace(status={"discord": "pending"}, needs_retry=False, calls=[])
    callback.submit = lambda *args, **kwargs: callback.calls.append((args, kwargs))

    async def authorize(actor):
        return actor is owner

    gateway = SimpleNamespace(runtime_service=SimpleNamespace(authorize_agent_identity=authorize),
                              channel_presentation=callback, broadcast=AsyncMock(),
                              broadcast_resource=AsyncMock())
    agent = SimpleNamespace(name="Example", system_prompt="Private persona", config={})
    service = AgentIdentityService(agent=agent, db=None, config_path=path, gateway=gateway)

    revision = (await service.get(owner))["revision"]
    with pytest.raises(AgentIdentityPermissionError):
        await service.update(object(), thumbnail=thumbnail())
    with pytest.raises(AgentIdentityInputError):
        await service.update(owner, thumbnail="data:image/png;base64,AAAA")
    result = await service.update(owner, thumbnail=thumbnail(), expected_revision=revision)
    raw = yaml.safe_load(path.read_text())
    assert raw["thumbnail"] == result["thumbnail"] == agent.config["thumbnail"]
    assert raw["system_prompt"] == "Private persona"
    jpeg = Image.open(io.BytesIO(base64.b64decode(raw["thumbnail"].split(",", 1)[1])))
    assert (jpeg.format, jpeg.size) == ("JPEG", (512, 512))
    assert callback.calls == [(("Example", result["thumbnail"]),
                               {"update_name": False, "update_thumbnail": True})]
    broadcast = gateway.broadcast.await_args.args[0]
    assert broadcast["thumbnail"] == result["thumbnail"] and "system_prompt" not in broadcast
    with pytest.raises(AgentIdentityConflict):
        await service.update(owner, name="Stale", expected_revision=revision)
    cleared = await service.update(owner, thumbnail=None, expected_revision=result["revision"])
    assert cleared["thumbnail"] is None and "thumbnail" not in yaml.safe_load(path.read_text())


@pytest.mark.asyncio
async def test_provider_failure_is_visible_and_retries_latest_profile(monkeypatch):
    from openagent_server import channel_presentation as module

    discord = AsyncMock(side_effect=[RuntimeError("Rate limited"), None])
    telegram = AsyncMock()
    monkeypatch.setattr(module, "sync_discord_profile", discord)
    monkeypatch.setattr(module, "sync_telegram_profile", telegram)
    sync = ChannelPresentationSync(
        [SimpleNamespace(name="discord", token="fixture"), SimpleNamespace(name="telegram", token="fixture")],
        {},
    )
    try:
        sync.submit("First name", None, update_name=True, update_thumbnail=False)
        await sync._task
        assert sync.status == {"discord": "Rate limited", "telegram": "synced"}
        sync.submit("Latest name", None, update_name=True, update_thumbnail=True)
        await sync._task
        assert sync.status == {"discord": "synced", "telegram": "synced"}
        assert discord.await_args.args[-1].name == "Latest name"
        assert discord.await_args.args[-1].update_thumbnail
    finally:
        await sync.close()


@pytest.mark.asyncio
async def test_slack_sync_preserves_the_existing_manifest_and_uploads_to_the_bound_app(monkeypatch):
    import json

    from openagent_channel_bridges import presentation
    from openagent_product_config.agent_thumbnail import normalize_thumbnail

    requests = AsyncMock(side_effect=[
        {"manifest": {"display_information": {"name": "App listing"},
                      "features": {"bot_user": {"display_name": "Old name", "always_online": True}}}},
        {"ok": True},
        {"ok": True},
    ])
    monkeypatch.setattr(presentation, "_request", requests)
    profile = presentation.ChannelPresentation("New name", normalize_thumbnail(thumbnail()), True, True)
    await presentation.sync_slack_profile(object(), "ATEST", "fixture-token", profile)
    export, update, icon = requests.await_args_list
    assert export.kwargs["json"] == {"app_id": "ATEST"}
    assert update.kwargs["json"]["app_id"] == "ATEST"
    manifest = json.loads(update.kwargs["json"]["manifest"])
    assert manifest["display_information"]["name"] == "App listing"
    assert manifest["features"]["bot_user"] == {"display_name": "New name", "always_online": True}
    assert icon.args[2] == "https://slack.com/api/apps.icon.set"
    assert icon.kwargs["data"].is_multipart
