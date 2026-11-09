"""Apply the standalone agent profile to its installed channel bindings."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable

import aiohttp

from openagent_channel_bridges.presentation import (
    ChannelPresentation,
    sync_discord_profile,
    sync_slack_profile,
    sync_telegram_profile,
)


class ChannelPresentationSync:
    """Run provider writes off the identity request path, in save order."""

    def __init__(self, bridges: Iterable, channels: dict) -> None:
        self._bridges = {bridge.name: bridge for bridge in bridges}
        self._slack = channels.get("slack") or {}
        self._pending: ChannelPresentation | None = None
        self._task: asyncio.Task | None = None
        self._failed: dict[str, tuple[bool, bool]] = {}
        self.status: dict[str, str] = {}

    @property
    def needs_retry(self) -> bool:
        return bool(self._failed)

    def submit(self, name: str, thumbnail: str | None, *, update_name: bool, update_thumbnail: bool) -> None:
        if not self._bridges:
            return
        previous = self._pending
        self._pending = ChannelPresentation(
            name, thumbnail, update_name or bool(previous and previous.update_name),
            update_thumbnail or bool(previous and previous.update_thumbnail),
        )
        self.status.update({channel: "pending" for channel in self._bridges
                            if update_name or update_thumbnail or channel in self._failed})
        if self._task is None:
            self._task = asyncio.create_task(self._drain(), name="channel-presentation")

    async def _drain(self) -> None:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12)) as session:
                while self._pending is not None:
                    profile, self._pending = self._pending, None
                    await asyncio.gather(*(self._apply(session, channel, bridge, profile)
                                           for channel, bridge in self._bridges.items()))
        finally:
            self._task = None

    async def _apply(self, session, channel, bridge, profile: ChannelPresentation) -> None:
        retry_name, retry_thumbnail = self._failed.get(channel, (False, False))
        desired = ChannelPresentation(profile.name, profile.thumbnail, profile.update_name or retry_name,
                                      profile.update_thumbnail or retry_thumbnail)
        if not desired.update_name and not desired.update_thumbnail:
            return
        self.status[channel] = "pending"
        try:
            if channel == "discord":
                await sync_discord_profile(session, bridge.token, desired)
            elif channel == "telegram":
                await sync_telegram_profile(session, bridge.token, desired)
            elif channel == "slack":
                await sync_slack_profile(session, self._slack.get("presentation_app_id", ""),
                                         self._slack.get("presentation_config_token", ""), desired)
            else:
                self.status[channel] = "This channel does not expose a managed bot profile."
                return
        except RuntimeError as exc:
            self._failed[channel] = (desired.update_name, desired.update_thumbnail)
            self.status[channel] = str(exc)
        except Exception:
            self._failed[channel] = (desired.update_name, desired.update_thumbnail)
            self.status[channel] = "Profile sync failed. Save again to retry."
        else:
            self._failed.pop(channel, None)
            self.status[channel] = "synced"

    async def close(self) -> None:
        self._pending = None
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
