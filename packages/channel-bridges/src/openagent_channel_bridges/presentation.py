"""Update the native profile of an explicitly configured channel bot."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass

import aiohttp


@dataclass(frozen=True)
class ChannelPresentation:
    name: str
    thumbnail: str | None
    update_name: bool
    update_thumbnail: bool

    def jpeg(self) -> bytes:
        prefix = "data:image/jpeg;base64,"
        if not self.thumbnail or not self.thumbnail.startswith(prefix):
            raise ValueError("Expected a normalized JPEG thumbnail.")
        return base64.b64decode(self.thumbnail[len(prefix):], validate=True)


async def _request(session, method, url, *, provider, **kwargs) -> dict:
    try:
        async with session.request(method, url, allow_redirects=False, **kwargs) as response:
            if response.status == 429:
                raise RuntimeError("Rate limited by the provider. Save again later to retry.")
            if response.status != 200:
                raise RuntimeError(f"{provider} rejected the profile update (HTTP {response.status}).")
            payload = await response.json()
            if not isinstance(payload, dict) or payload.get("ok") is False:
                raise RuntimeError(f"{provider} rejected the profile update. Check its settings and permissions.")
            return payload
    except (aiohttp.ClientError, TimeoutError, ValueError):
        # Provider URLs may contain credentials. Never propagate raw SDK or
        # HTTP errors into owner-visible status, logs or tracing.
        raise RuntimeError(f"Could not reach {provider}. Save again to retry.") from None


async def sync_discord_profile(session, bot_token: str, profile: ChannelPresentation) -> None:
    url = "https://discord.com/api/v10/users/@me"
    headers = {"Authorization": f"Bot {bot_token}"}
    fields = {}
    if profile.update_name:
        if not 2 <= len(profile.name) <= 32:
            raise RuntimeError("Discord bot names must contain 2 to 32 characters.")
        fields["username"] = profile.name
    if profile.update_thumbnail:
        fields["avatar"] = profile.thumbnail
    if fields:
        await _request(session, "PATCH", url, provider="Discord", headers=headers, json=fields)


async def sync_telegram_profile(session, bot_token: str, profile: ChannelPresentation) -> None:
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", bot_token):
        raise RuntimeError("Telegram bot credentials are invalid.")
    url = f"https://api.telegram.org/bot{bot_token}/"
    if profile.update_name:
        if len(profile.name) > 64:
            raise RuntimeError("Telegram bot names must be at most 64 characters.")
        await _request(session, "POST", url + "setMyName", provider="Telegram", json={"name": profile.name})
    if profile.update_thumbnail:
        if profile.thumbnail is None:
            await _request(session, "POST", url + "removeMyProfilePhoto", provider="Telegram")
        else:
            data = aiohttp.FormData()
            data.add_field("photo", json.dumps({"type": "static", "photo": "attach://thumbnail"}))
            data.add_field("thumbnail", profile.jpeg(), filename="thumbnail.jpg", content_type="image/jpeg")
            await _request(session, "POST", url + "setMyProfilePhoto", provider="Telegram", data=data)


async def sync_slack_profile(session, app_id: str, config_token: str, profile: ChannelPresentation) -> None:
    if not re.fullmatch(r"A[A-Z0-9]+", app_id) or not config_token:
        raise RuntimeError("Set the Slack app ID and an app configuration token to sync its profile.")
    headers = {"Authorization": f"Bearer {config_token}"}
    url = "https://slack.com/api/"
    if profile.update_name:
        if len(profile.name) > 80:
            raise RuntimeError("Slack bot display names must be at most 80 characters.")
        exported = await _request(session, "POST", url + "apps.manifest.export", provider="Slack",
                                  headers=headers, json={"app_id": app_id})
        manifest = exported.get("manifest")
        bot = manifest.get("features", {}).get("bot_user") if isinstance(manifest, dict) else None
        if not isinstance(bot, dict):
            raise RuntimeError("The Slack app does not have a bot user.")
        if bot.get("display_name") != profile.name:
            bot["display_name"] = profile.name
            await _request(session, "POST", url + "apps.manifest.update", provider="Slack",
                           headers=headers, json={"app_id": app_id, "manifest": json.dumps(manifest, ensure_ascii=False)})
    if profile.update_thumbnail:
        if profile.thumbnail is None:
            raise RuntimeError("Remove the custom app icon in Slack app settings.")
        data = aiohttp.FormData()
        data.add_field("app_id", app_id)
        data.add_field("file", profile.jpeg(), filename="thumbnail.jpg", content_type="image/jpeg")
        await _request(session, "POST", url + "apps.icon.set", provider="Slack", headers=headers, data=data)
