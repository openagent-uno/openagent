"""Discord channel adapter using the host's explicitly supplied transport.

Registers native Discord slash commands and handles messages via
the same authorized host runtime. Provider context does not grant host access.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import tempfile
import time
from dataclasses import replace
from pathlib import Path

from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import BridgeAttachment, BridgeContext, BridgeHistoryMessage, BridgePart
from openagent_channel_bridges.history import bound_history, validate_context_messages
from openagent_channel_bridges.history_media import prepare_history_media, HistoryUnavailable
from openagent_channel_bridges.diagnostics import emit_diagnostic
from openagent_core.media import is_blocked_attachment
from openagent_channel_bridges.media import is_audio_file
from openagent_channel_bridges.commands import BOT_COMMANDS, bridge_welcome_text
from openagent_channel_bridges.media import (
    attachment_limit_bytes,
    safe_attachment_filename,
    safe_attachment_staging_name,
    authorized_file_chunks, media_file_snapshot, write_authorized_download,
    read_authorized_response,
)

from openagent_channel_bridges.base import elog

logger = logging.getLogger(__name__)

DISCORD_MSG_LIMIT = 2000
_DISCORD_MEDIA_DOWNLOAD_TIMEOUT = 120.0
_VIEW_CHANNEL = 1 << 10
_SEND_MESSAGES = 1 << 11
_READ_MESSAGE_HISTORY = 1 << 16
_MANAGE_THREADS = 1 << 34
_SEND_MESSAGES_IN_THREADS = 1 << 38
_ADMINISTRATOR = 1 << 3
_ALL_PERMISSIONS = (1 << 64) - 1


def _build_picker_view(bridge, session_id: str, picker: dict):
    """Build a Discord Select-menu ``View`` for a structured command picker
    (e.g. the /model chooser). Returns ``None`` when discord.ui is
    unavailable or there are no renderable options — the caller then falls
    back to the plain-text option list.

    Discord dispatches component interactions straight to the View, so the
    Select's own ``callback`` re-issues the command with the chosen value;
    no global interaction handler is needed.
    """
    try:
        import discord
    except Exception:
        return None
    command = str(picker.get("command") or "")
    raw = picker.get("options") or []
    if not command or not raw:
        return None
    options = []
    for opt in raw[:25]:  # Discord Select hard cap of 25 options
        value = str(opt.get("value") or "")
        if not value:
            continue
        label = str(opt.get("label") or value)[:100]
        desc = (str(opt.get("subtitle") or "")[:100]) or None
        options.append(discord.SelectOption(
            label=label, value=value[:100], description=desc,
            default=bool(opt.get("active")),
        ))
    if not options:
        return None

    class _PickerSelect(discord.ui.Select):
        def __init__(self) -> None:
            super().__init__(
                placeholder=str(picker.get("prompt") or "Choose…")[:150],
                min_values=1, max_values=1, options=options,
            )

        async def callback(self, interaction) -> None:  # noqa: ANN001
            value = self.values[0]
            context = bridge._bridge_context(interaction)
            uid, cid, gid, is_dm = bridge._interaction_scope(interaction)
            if not bridge._scope_allowed(uid, cid, gid, is_dm=is_dm):
                raise PermissionError("Discord command context is no longer admitted")
            result = await bridge.send_command(
                command, session_id=session_id, arg=value,
                context=context,
            )
            try:
                await bridge._prepare_delivery_context(context)
                await interaction.response.edit_message(
                    content=result or "Done.", view=None,
                )
            except Exception:
                pass

    view = discord.ui.View(timeout=300)
    view.add_item(_PickerSelect())
    return view


class _DiscordTypingAnimator:
    """Keeps Discord's native "Bot is typing…" indicator lit for the whole
    turn — the in-chat equivalent of Telegram's ``ChatAction.TYPING``
    animator, so the agent never has to post a ``Thinking…`` placeholder.

    ``channel.typing()`` is an async context manager that re-triggers the
    indicator on Discord's ~10 s cadence while the block is open, so we
    just hold it open on a background task until ``stop()`` is called.
    """

    def __init__(self, channel) -> None:
        self._channel = channel
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        async def _loop() -> None:
            try:
                async with self._channel.typing():
                    await self._stop.wait()
            except Exception as e:  # noqa: BLE001
                # Missing permission / deleted channel / network blip —
                # the typing dot is best-effort; the reply still lands.
                logger.debug("discord typing indicator failed: %s", type(e).__name__)
        self._task = asyncio.create_task(_loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=1.0)
            except (asyncio.TimeoutError, Exception):
                pass
            self._task = None


class DiscordBridge(BaseBridge):
    name = "discord"
    message_limit = DISCORD_MSG_LIMIT

    def __init__(
        self,
        token: str,
        allowed_users: list[str] | None = None,
        allowed_guilds: list[str] | None = None,
        listen_channels: list[str] | None = None,
        dm_only: bool = False,
        personality: str | None = None,
        live: bool | None = None,
        *,
        transport,
        binding_id: str,
        context_messages: int = 20,
        members_intent: bool = False,
        delivery_mode: str | None = None,
        acknowledgement_text: str | None = None,
    ):
        super().__init__(transport=transport, binding_id=binding_id, personality=personality,
                         live=live, delivery_mode=delivery_mode, acknowledgement_text=acknowledgement_text)
        if not isinstance(binding_id, str) or not binding_id:
            raise ValueError("A host-owned binding_id is required")
        self.binding_id = binding_id
        self.context_messages = validate_context_messages(context_messages)
        if type(members_intent) is not bool:
            raise ValueError("members_intent must be a boolean")
        self.members_intent = members_intent
        self.token = token
        self.allowed_users = set(str(u) for u in (allowed_users or []))
        self.allowed_guilds = set(str(g) for g in (allowed_guilds or []))
        self.listen_channels = set(str(c) for c in (listen_channels or []))
        self.dm_only = dm_only
        self._client = None
        self._event_clients: dict[tuple, object] = {}
        self._audience_denied_events: set[tuple] = set()
        self._audience_session = None

    def _bridge_context(self, message) -> BridgeContext:
        actor = getattr(message, "author", None) or getattr(message, "user", None)
        channel = message.channel
        guild = getattr(message, "guild", None)
        account = str(guild.id) if guild else str(getattr(getattr(self._client, "user", None), "id", ""))
        thread = str(channel.id) if getattr(channel, "parent_id", None) is not None else None
        conversation = str(channel.parent_id) if thread is not None else str(channel.id)
        reference = getattr(message, "reference", None)
        reply = str(reference.message_id) if getattr(reference, "message_id", None) is not None else None
        return BridgeContext(self.binding_id, self.name, account, str(actor.id),
                             conversation, str(message.id), thread_id=thread,
                             reply_to_event_id=reply,
                             conversation_kind=self._conversation_kind(channel, guild))

    @staticmethod
    def _conversation_kind(channel, guild) -> str:
        if getattr(channel, "parent_id", None) is not None:
            return "thread"
        if guild is not None:
            return "channel"
        # guild=None includes group DMs; only the SDK's actual DMChannel is
        # a two-party direct conversation. A cached recipient list is no proof.
        try:
            import discord
            if isinstance(channel, discord.DMChannel):
                return "direct"
            if isinstance(channel, discord.GroupChannel):
                return "group"
        except (ImportError, AttributeError):
            pass
        return "unknown"

    @staticmethod
    def _event_key(context: BridgeContext) -> tuple:
        return tuple(getattr(context, field) for field in (
            "binding_id", "provider", "account_id", "actor_id", "conversation_id",
            "event_id", "thread_id", "reply_to_event_id", "api_version", "conversation_kind"))

    @staticmethod
    def _snowflake(value) -> str:
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            raise ValueError("Invalid Discord identity")
        result = str(value)
        if not result.isascii() or not result.isdecimal() or not 0 < int(result) < 1 << 64 or str(int(result)) != result:
            raise ValueError("Invalid Discord identity")
        return result

    @staticmethod
    def _permission_bits(value) -> int:
        if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or not 0 <= int(value) <= _ALL_PERMISSIONS:
            raise ValueError("Invalid Discord permissions")
        return int(value)

    async def _audience_rest(self, context, path, *, params=None):
        """Read bounded official REST metadata using only the configured bot.

        Public SDK role/overwrite views discard unresolved IDs. Raw REST data
        lets the proof reject these incomplete snapshots instead of omitting a
        potential reader. No cache, redirects, retries or automatic grants.
        """
        import aiohttp
        await self.authorize_context(context)
        if self._audience_session is None or self._audience_session.closed:
            self._audience_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        async with self._audience_session.get(
            "https://discord.com/api/v10" + path, params=params,
            headers={"Authorization": "Bot " + self.token}, allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise ValueError("Discord audience metadata unavailable")
            raw = await read_authorized_response(
                response.content, lambda: self.authorize_context(context), limit=8 * 1024 * 1024,
            )
        await self.authorize_context(context)
        return json.loads(raw)

    def _roles_snapshot(self, guild, guild_id):
        if not isinstance(guild, dict) or self._snowflake(guild.get("id")) != guild_id:
            raise ValueError("Discord guild differs from binding")
        owner = self._snowflake(guild.get("owner_id"))
        raw = guild.get("roles")
        if not isinstance(raw, list) or not raw or len(raw) > 1000:
            raise ValueError("Incomplete Discord roles")
        roles = {}
        for role in raw:
            role_id = self._snowflake(role.get("id"))
            if role_id in roles:
                raise ValueError("Duplicate Discord role")
            roles[role_id] = self._permission_bits(role.get("permissions"))
        if guild_id not in roles:
            raise ValueError("Missing Discord default role")
        return owner, roles

    def _channel_snapshot(self, raw, channel_id, guild_id, roles, *, thread=False):
        if (not isinstance(raw, dict) or self._snowflake(raw.get("id")) != channel_id
                or self._snowflake(raw.get("guild_id")) != guild_id or type(raw.get("type")) is not int):
            raise ValueError("Discord channel topology cannot be verified")
        kind = raw["type"]
        if thread:
            if kind not in (10, 11, 12):
                raise ValueError("Discord thread type cannot be verified")
            parent = self._snowflake(raw.get("parent_id"))
            metadata = raw.get("thread_metadata")
            if (parent == channel_id or not isinstance(metadata, dict)
                    or metadata.get("archived") is not False or metadata.get("locked") is not False):
                raise ValueError("Discord thread is archived, locked or incomplete")
            return kind, parent
        if kind not in (0, 5, 15, 16):
            raise ValueError("Discord channel type cannot be verified")
        overwrites = raw.get("permission_overwrites")
        if not isinstance(overwrites, list) or len(overwrites) > 1000:
            raise ValueError("Incomplete Discord permission overwrites")
        resolved = {}
        for overwrite in overwrites:
            target = self._snowflake(overwrite.get("id"))
            overwrite_type = overwrite.get("type")
            if type(overwrite_type) is not int or overwrite_type not in (0, 1) or (overwrite_type, target) in resolved:
                raise ValueError("Invalid Discord permission overwrite")
            if overwrite_type == 0 and target not in roles:
                raise ValueError("Unresolved Discord overwrite role")
            resolved[overwrite_type, target] = (
                self._permission_bits(overwrite.get("allow")), self._permission_bits(overwrite.get("deny")),
            )
        return kind, resolved

    def _member_snapshot(self, raw, roles):
        if not isinstance(raw, dict) or not isinstance(raw.get("user"), dict):
            raise ValueError("Invalid Discord member")
        member_id = self._snowflake(raw["user"].get("id"))
        assigned = raw.get("roles")
        if not isinstance(assigned, list) or len(assigned) > 1000:
            raise ValueError("Incomplete Discord member roles")
        ids = tuple(self._snowflake(value) for value in assigned)
        if len(set(ids)) != len(ids) or any(role not in roles for role in ids):
            raise ValueError("Unresolved Discord member roles")
        return member_id, frozenset(ids)

    async def _guild_members(self, context, roles):
        members, after = {}, None
        # Discord's guild limit is 1000. A full page needs a one-item overflow
        # probe: a cap is never presented as proof of enumeration completion.
        for _ in range(2):
            limit = 1000 if not members else 1
            params = {"limit": limit}
            if after is not None:
                params["after"] = after
            raw = await self._audience_rest(context, f"/guilds/{context.account_id}/members", params=params)
            if not isinstance(raw, list) or len(raw) > limit:
                raise ValueError("Invalid Discord member page")
            previous = after
            for item in raw:
                member, assigned = self._member_snapshot(item, roles)
                if member in members or previous is not None and int(member) <= int(previous) or len(members) >= 1000:
                    raise ValueError("Incomplete Discord member enumeration")
                members[member] = assigned
                previous = member
            if len(raw) < limit:
                return members
            after = str(max(map(int, members)))
        raise ValueError("Discord member enumeration exceeds limit")

    async def _private_thread_members(self, context, members, roles):
        joined, after = set(), None
        for page in range(11):
            limit = 1 if page == 10 else 100
            params = {"with_member": "true", "limit": limit}
            if after is not None:
                params["after"] = after
            raw = await self._audience_rest(context, f"/channels/{context.thread_id}/thread-members", params=params)
            if not isinstance(raw, list) or len(raw) > limit:
                raise ValueError("Invalid Discord thread member page")
            previous = after
            for item in raw:
                if self._snowflake(item.get("id")) != context.thread_id:
                    raise ValueError("Discord member belongs to another thread")
                member = self._snowflake(item.get("user_id"))
                nested_id, assigned = self._member_snapshot(item.get("member"), roles)
                if (nested_id != member or member not in members or assigned != members[member]
                        or member in joined or previous is not None and int(member) <= int(previous) or len(joined) >= 1000):
                    raise ValueError("Incomplete Discord thread membership")
                joined.add(member)
                previous = member
            if len(raw) < limit:
                return joined
            after = str(max(map(int, joined)))
        raise ValueError("Discord thread enumeration exceeds limit")

    @staticmethod
    def _effective_permissions(member, assigned, *, owner, roles, overwrites, guild_id):
        bits = roles[guild_id]
        for role in assigned:
            bits |= roles[role]
        if member == owner or bits & _ADMINISTRATOR:
            return _ALL_PERMISSIONS
        allow, deny = overwrites.get((0, guild_id), (0, 0))
        bits = bits & ~deny | allow
        allow, deny = 0, 0
        for role in assigned - {guild_id}:
            permitted, rejected = overwrites.get((0, role), (0, 0))
            allow |= permitted
            deny |= rejected
        bits = bits & ~deny | allow
        allow, deny = overwrites.get((1, member), (0, 0))
        return bits & ~deny | allow

    async def _guild_audience(self, context, bot):
        self._snowflake(context.account_id)
        self._snowflake(context.conversation_id)
        self._snowflake(context.actor_id)
        self._snowflake(bot)
        is_thread = context.conversation_kind == "thread"
        if (not is_thread and context.thread_id is not None
                or is_thread and (context.thread_id is None or context.thread_id == context.conversation_id)):
            raise ValueError("Discord thread binding differs")
        destination_id = self._snowflake(context.thread_id) if is_thread else context.conversation_id
        guild_path = f"/guilds/{context.account_id}"
        channel_path = f"/channels/{destination_id}"
        guild = await self._audience_rest(context, guild_path)
        owner, roles = self._roles_snapshot(guild, context.account_id)
        channel = await self._audience_rest(context, channel_path)
        topology = self._channel_snapshot(channel, destination_id, context.account_id, roles, thread=is_thread)
        parent_path, parent_state = None, None
        if is_thread:
            kind, parent_id = topology
            if parent_id != context.conversation_id:
                raise ValueError("Discord thread does not belong to the authorized parent")
            parent_path = f"/channels/{parent_id}"
            parent = await self._audience_rest(context, parent_path)
            parent_state = self._channel_snapshot(parent, parent_id, context.account_id, roles)
            if parent_state[0] not in {10: (5,), 11: (0, 15, 16), 12: (0,)}[kind]:
                raise ValueError("Discord thread parent type differs")
            overwrites = parent_state[1]
        else:
            kind, overwrites = topology
            if kind not in (0, 5):
                raise ValueError("Discord messages require a channel or explicit thread")
        members = await self._guild_members(context, roles)
        joined = await self._private_thread_members(context, members, roles) if is_thread and kind == 12 else None
        audience, bot_permissions = set(), None
        for member, assigned in members.items():
            permissions = self._effective_permissions(member, assigned, owner=owner, roles=roles,
                                                       overwrites=overwrites, guild_id=context.account_id)
            can_view = bool(permissions & _VIEW_CHANNEL) and (joined is None or member in joined or bool(permissions & _MANAGE_THREADS))
            if can_view and member == str(bot):
                bot_permissions = permissions
            elif can_view:
                audience.add(member)
        needed = _VIEW_CHANNEL | (_SEND_MESSAGES_IN_THREADS if is_thread else _SEND_MESSAGES)
        if context.actor_id not in audience or bot_permissions is None or bot_permissions & needed != needed:
            raise ValueError("Discord actor or bot cannot access destination")
        # Catch role/overwrite/topology changes during the bounded scans. This
        # is repeated before each delivery; REST observations are not atomic.
        if self._roles_snapshot(await self._audience_rest(context, guild_path), context.account_id) != (owner, roles):
            raise ValueError("Discord roles changed during audience scan")
        if self._channel_snapshot(await self._audience_rest(context, channel_path), destination_id,
                                  context.account_id, roles, thread=is_thread) != topology:
            raise ValueError("Discord channel changed during audience scan")
        if parent_path is not None and self._channel_snapshot(await self._audience_rest(context, parent_path),
                parent_id, context.account_id, roles) != parent_state:
            raise ValueError("Discord parent changed during audience scan")
        if await self._guild_members(context, roles) != members:
            raise ValueError("Discord members or assigned roles changed during audience scan")
        if joined is not None and await self._private_thread_members(context, members, roles) != joined:
            raise ValueError("Discord thread membership changed during audience scan")
        await self.authorize_context(context)
        return replace(context, audience_ids=tuple(sorted(audience)), audience_complete=True,
                       audience_verified_at=time.time())

    async def _delivery_context(self, context: BridgeContext) -> BridgeContext:
        await self.authorize_context(context)
        incomplete = replace(context, audience_ids=(), audience_complete=False,
                             audience_verified_at=None)
        key = self._event_key(context)

        def deny_audience():
            # A failed proof ends this exact turn. Error/status rendering must
            # not repeat a capped scan or turn an incomplete result into output.
            if key in self._event_clients:
                self._audience_denied_events.add(key)
            if context.conversation_kind == "direct":
                raise PermissionError("Discord direct audience cannot be verified")
            return incomplete

        if key in self._audience_denied_events:
            return deny_audience()
        client = self._event_clients.get(self._event_key(context)) or self._client
        bot = getattr(getattr(client, "user", None), "id", None)
        if bot is None:
            return deny_audience()
        guild_id = None if context.conversation_kind in ("direct", "group", "unknown") else context.account_id
        if not self._scope_allowed(context.actor_id, context.conversation_id, guild_id,
                                   is_dm=context.conversation_kind == "direct"):
            raise PermissionError("Discord context is no longer admitted")
        try:
            if context.conversation_kind == "direct":
                if str(bot) != context.account_id:
                    raise ValueError("Discord bot account differs from its binding")
                await self.authorize_context(context)
                channel = await client.fetch_channel(int(context.conversation_id))
                if (self._conversation_kind(channel, None) != "direct"
                        or str(channel.id) != context.conversation_id
                        or str(getattr(getattr(channel, "recipient", None), "id", "")) != context.actor_id):
                    raise ValueError("Discord direct participant cannot be verified")
                await self.authorize_context(context)
                return replace(context, audience_ids=(context.actor_id,), audience_complete=True,
                               audience_verified_at=time.time())
            if context.conversation_kind not in ("channel", "thread"):
                return deny_audience()
            if not self.members_intent or getattr(getattr(client, "intents", None), "members", False) is not True:
                return deny_audience()
            async with asyncio.timeout(30):
                return await self._guild_audience(context, bot)
        except PermissionError:
            raise
        except Exception as exc:
            logger.warning("Discord audience unavailable: %s", type(exc).__name__)
            return deny_audience()

    async def _history(self, message, context: BridgeContext, *, media_directory=None,
                       current_attachments=()) -> tuple[BridgeHistoryMessage, ...]:
        if not self.context_messages:
            return ()
        guild = getattr(message, "guild", None)
        gid = str(guild.id) if guild else None
        if not self._scope_allowed(context.actor_id, context.conversation_id, gid, is_dm=guild is None):
            raise PermissionError("Discord context is no longer admitted")
        context = await self._prepare_delivery_context(context)
        destination_id = context.thread_id or context.conversation_id
        if str(message.channel.id) != destination_id:
            raise PermissionError("Discord history target differs from its context")
        records = []
        files = {}
        # A Thread is itself the exact channel object. Never follow references
        # into another channel or fetch from a guild-wide search endpoint.
        try:
            iterator = message.channel.history(limit=self.context_messages + 1, before=message, oldest_first=False).__aiter__()
            while True:
                await self.authorize_context(context)
                try:
                    item = await anext(iterator)
                except StopAsyncIteration:
                    break
                await self.authorize_context(context)
                if str(getattr(getattr(item, "channel", None), "id", "")) != destination_id:
                    continue
                item_guild = getattr(item, "guild", None)
                if (str(item_guild.id) if item_guild else None) != gid or str(item.id) == context.event_id:
                    continue
                if int(item.id) >= int(message.id):
                    continue
                text = getattr(item, "content", None)
                actor = str(getattr(getattr(item, "author", None), "id", ""))
                if actor:
                    timestamp = getattr(item, "created_at", None)
                    parts = [BridgePart(text=text)] if isinstance(text, str) and text else []
                    for value in tuple(getattr(item, "attachments", ()) or ())[:16]:
                        if getattr(value, "id", None) is None:
                            continue
                        name = safe_attachment_filename(value.filename)
                        mime = str(getattr(value, "content_type", None) or "application/octet-stream")
                        kind = "voice" if is_audio_file(name, mime) else "image" if mime.startswith("image/") else "video" if mime.startswith("video/") else "file"
                        attachment = BridgeAttachment(kind, name, mime, max(0, int(getattr(value, "size", 0) or 0)),
                            provider_attachment_id=str(value.id))
                        files[(str(item.id), attachment.provider_attachment_id)] = value
                        parts.append(BridgePart(attachment=attachment))
                    if parts:
                        records.append(BridgeHistoryMessage(str(item.id), actor, tuple(parts),
                            timestamp=timestamp.isoformat() if timestamp else None))
        except PermissionError:
            raise
        except Exception:
            # Requested context must not silently become an invented empty
            # history. No scope expansion or broader-channel fallback exists.
            logger.warning("Discord channel context unavailable")
            await self.authorize_context(context)
            emit_diagnostic(context, "history", "unavailable")
            raise HistoryUnavailable("Requested channel history is unavailable") from None
        records.sort(key=lambda item: int(item.event_id))
        await self._prepare_delivery_context(context)
        selected = bound_history(records, context_messages=self.context_messages, exclude_event_id=context.event_id)
        async def load(record, attachment, remaining_bytes):
            if media_directory is None:
                raise ValueError("Historical media staging unavailable")
            directory = tempfile.mkdtemp(prefix="history-", dir=media_directory)
            path = Path(directory) / safe_attachment_staging_name(attachment.provider_attachment_id, attachment.filename)
            await self._download_attachment(files[(record.event_id, attachment.provider_attachment_id)], path,
                context=context, channel_id=destination_id, max_bytes=remaining_bytes)
            return replace(attachment, local_path=str(path), size_bytes=path.stat().st_size)
        selected = await prepare_history_media(self, selected, context, load,
                                               current_attachments=current_attachments)
        return bound_history(selected, context_messages=self.context_messages, exclude_event_id=context.event_id)

    @staticmethod
    def _session_id(
        user_id: str,
        channel_id: str | None,
        guild_id: str | None,
        *,
        is_dm: bool,
    ) -> str:
        """Return a private DM scope or a shared guild-channel scope."""
        if is_dm or not guild_id or not channel_id:
            return f"dc:{user_id}"
        return f"dc:guild:{guild_id}:channel:{channel_id}"

    def _scope_allowed(
        self,
        user_id: str,
        channel_id: str | None,
        guild_id: str | None,
        *,
        is_dm: bool,
    ) -> bool:
        if is_dm:
            return user_id in self.allowed_users
        if self.dm_only:
            return False
        if self.allowed_guilds and guild_id not in self.allowed_guilds:
            return False
        return bool(channel_id and channel_id in self.listen_channels)

    @staticmethod
    def _interaction_scope(interaction) -> tuple[str, str | None, str | None, bool]:
        uid = str(interaction.user.id)
        channel_id = getattr(interaction, "channel_id", None)
        if channel_id is None:
            channel_id = getattr(getattr(interaction, "channel", None), "id", None)
        parent_id = getattr(getattr(interaction, "channel", None), "parent_id", None)
        if parent_id is not None:
            channel_id = parent_id
        guild_id = getattr(interaction, "guild_id", None)
        if guild_id is None:
            guild_id = getattr(getattr(interaction, "guild", None), "id", None)
        cid = str(channel_id) if channel_id is not None else None
        gid = str(guild_id) if guild_id is not None else None
        return uid, cid, gid, gid is None

    async def _run(self) -> None:
        try:
            import discord
            from discord import app_commands
        except ImportError:
            raise ImportError("discord.py required. Install: pip install openagent-framework[discord]")

        intents = discord.Intents.default()
        intents.message_content = True
        intents.members = self.members_intent
        client = discord.Client(intents=intents)
        tree = app_commands.CommandTree(client)
        self._client = client

        # ── Register slash commands ──

        def _make_command_handler(command_name: str):
            async def _handler(
                interaction: discord.Interaction,
                arg: str | None = None,
            ) -> None:
                await self._handle_slash(interaction, command_name, arg=arg)

            _handler.__name__ = f"_cmd_{command_name.replace('-', '_')}"
            return _handler

        for command_name, description in self.supported_commands:
            tree.command(
                name=command_name,
                description=description,
            )(_make_command_handler(command_name))

        # Welcome message — symmetric with Telegram /start.  Not part of
        # BOT_COMMANDS because the gateway has no /start command; this is
        # a bridge-local convenience.
        async def _start_handler(interaction: discord.Interaction):
            uid, cid, gid, is_dm = self._interaction_scope(interaction)
            if not self._scope_allowed(uid, cid, gid, is_dm=is_dm):
                await interaction.response.send_message("Unauthorized.", ephemeral=True)
                return
            name = interaction.user.display_name or interaction.user.name
            await interaction.response.send_message(bridge_welcome_text(name), ephemeral=True)

        tree.command(name="start", description="Show welcome and command list")(_start_handler)

        # ── Events ──

        @client.event
        async def on_ready():
            logger.info("Discord bridge connected as %s", client.user)
            # Operator hint: surface the effective receive-side config so
            # silent message drops are debuggable from events.jsonl alone.
            elog("bridge.discord.config",
                 allowed_users=len(self.allowed_users),
                 allowed_guilds=len(self.allowed_guilds),
                 listen_channels=len(self.listen_channels),
                 dm_only=self.dm_only)
            try:
                if self.allowed_guilds:
                    for gid in self.allowed_guilds:
                        guild = discord.Object(id=int(gid))
                        tree.copy_global_to(guild=guild)
                        await tree.sync(guild=guild)
                else:
                    await tree.sync()
                logger.info("Discord slash commands synced")
            except Exception as e:
                logger.warning("Slash command sync failed: %s", type(e).__name__)

        @client.event
        async def on_message(message):
            if message.author == client.user:
                return
            uid = str(message.author.id)
            native_channel_id = str(getattr(message.channel, "id", "")) or None
            parent_id = getattr(message.channel, "parent_id", None)
            cid = str(parent_id) if parent_id is not None else native_channel_id
            gid = str(message.guild.id) if getattr(message, "guild", None) else None
            is_dm = isinstance(message.channel, discord.DMChannel)
            if is_dm:
                # ``allowed_users`` is the private-conversation boundary.
                # Public channel access is controlled independently below by
                # ``listen_channels`` so every member of an explicitly listed
                # channel can talk to the agent without also being copied into
                # a global user allowlist.
                if not self._scope_allowed(uid, cid, gid, is_dm=True):
                    elog("bridge.discord.dropped", reason="not_allowed_user",
                         user_id=uid, channel_id=cid)
                    return
            elif self.dm_only:
                elog("bridge.discord.dropped", reason="dm_only_rejecting_guild",
                     user_id=uid, channel_id=cid, guild_id=gid)
                return
            elif self.allowed_guilds and gid not in self.allowed_guilds:
                elog("bridge.discord.dropped", reason="guild_not_allowed",
                     user_id=uid, channel_id=cid, guild_id=gid)
                return
            elif cid not in self.listen_channels:
                # A configured channel is an explicit shared doorway: accept
                # all of its human members, and never let an ``allowed_users``
                # entry bypass the channel boundary. This keeps two agents in
                # the same Discord server from both answering an operator in
                # an unrelated channel.
                elog("bridge.discord.dropped", reason="channel_not_listened",
                     user_id=uid, channel_id=cid, guild_id=gid)
                return
            if not is_dm and (client.user is None or str(client.user.id) not in {
                str(user.id) for user in message.mentions
            }):
                elog("bridge.discord.dropped", reason="not_mentioned",
                     user_id=uid, channel_id=cid, guild_id=gid)
                return

            elog("bridge.message", bridge="discord", user_id=uid)
            bridge_context = self._bridge_context(message)
            await self.authorize_context(bridge_context)
            content = message.content or ""
            if client.user:
                content = content.replace(f"<@{client.user.id}>", "").replace(f"<@!{client.user.id}>", "").strip()

            # Process attachments
            blocked = []
            attachments: list[dict] = []
            voice_detected = False
            tmp = tempfile.mkdtemp(prefix="oa_dc_")
            key = self._event_key(bridge_context)
            if key in self._event_clients:
                shutil.rmtree(tmp, ignore_errors=True)
                raise PermissionError("Discord event is already active")
            self._event_clients[key] = client
            acknowledged = False
            try:
                # Pin this turn's audience before files, speech or history.
                # Later reads cannot bootstrap a newly joined recipient into
                # an already running input under an incomplete context.
                bridge_context = await self._prepare_delivery_context(bridge_context)
                emit_diagnostic(bridge_context, "admission", "completed")
                if not content and not message.attachments:
                    return
                acknowledged = await self.acknowledge_turn(message.channel, context=bridge_context)
                for att in message.attachments:
                    filename = safe_attachment_filename(att.filename)
                    if is_blocked_attachment(filename):
                        blocked.append(filename)
                        continue
                    ct = att.content_type or ""
                    limit = attachment_limit_bytes(direction="input")
                    declared_size = int(getattr(att, "size", 0) or 0)
                    if limit and declared_size > limit:
                        blocked.append(f"{filename} (too large)")
                        continue
                    unique = safe_attachment_filename(
                        getattr(att, "id", None) or "discord",
                        fallback="discord",
                    )
                    path = Path(tmp) / safe_attachment_staging_name(unique, filename)
                    try:
                        await self._download_attachment(att, path, context=bridge_context,
                                                        channel_id=str(message.channel.id))
                        await self.authorize_context(bridge_context)
                        actual_size = path.stat().st_size
                        if limit and actual_size > limit:
                            with contextlib.suppress(OSError):
                                path.unlink()
                            blocked.append(f"{filename} (too large)")
                            continue
                    except Exception as exc:  # noqa: BLE001
                        # The streaming helper cleans only files it created.
                        # Never remove an existing file after a failed open.
                        if isinstance(exc, PermissionError):
                            raise
                        elog(
                            "bridge.discord.attachment_download_failed",
                            level="warning",
                            filename=filename,
                            error_type=type(exc).__name__,
                        )
                        continue

                    is_voice = is_audio_file(filename, ct)
                    kind = (
                        "voice" if is_voice
                        else "image" if ct.startswith("image/")
                        else "video" if ct.startswith("video/")
                        else "file"
                    )
                    attachments.append({
                        "type": kind,
                        "kind": kind,
                        "path": str(path.resolve()),
                        "filename": filename,
                        "mime_type": ct or None,
                        "size_bytes": actual_size,
                        "provider_attachment_id": str(att.id) if getattr(att, "id", None) is not None else None,
                    })
                    if is_voice:
                        voice_detected = True
                        speech_context = await self._prepare_delivery_context(bridge_context)
                        t = await self.transcribe_with_fallback(str(path), context=speech_context,
                            attachment=BridgeAttachment(kind=kind, filename=filename, mime_type=ct or None,
                                size_bytes=actual_size, local_path=str(path.resolve()),
                                provider_attachment_id=str(att.id) if getattr(att, "id", None) is not None else None))
                        await self._prepare_delivery_context(bridge_context)
                        content = f"{content}\n{t}" if content else t

                if blocked:
                    await self._prepare_delivery_context(bridge_context)
                    await message.channel.send(f"⚠️ Blocked: {', '.join(blocked)}")

                if not content and not attachments:
                    return

                display = str(
                    getattr(message.author, "display_name", None)
                    or getattr(message.author, "name", None)
                    or uid
                )
                await self.dispatch_turn(
                    message.channel,
                    self._session_id(uid, native_channel_id, gid, is_dm=is_dm),
                    content,
                    context=bridge_context,
                    acknowledged=acknowledged,
                    history=await self._history(message, bridge_context, media_directory=tmp,
                                                current_attachments=attachments),
                    voice_detected=voice_detected,
                    attachments=attachments,
                    author={
                        "kind": "human",
                        "handle": f"discord:{uid}",
                        "display": display,
                    },
                )
            except asyncio.CancelledError:
                emit_diagnostic(bridge_context, "terminal", "cancelled")
                raise
            except Exception as exc:
                emit_diagnostic(bridge_context, "terminal", "authorization_denied" if isinstance(exc, PermissionError) else "failed")
                if isinstance(exc, PermissionError):
                    raise
                if not isinstance(exc, PermissionError):
                    failure = "I couldn’t read the requested channel history. No agent task was started." if isinstance(exc, HistoryUnavailable) else "I couldn’t complete this channel request. Please check the agent session before trying again."
                    try:
                        await self.send_text_chunk(message.channel, failure)
                    except Exception:
                        pass
            finally:
                self._event_clients.pop(key, None)
                self._audience_denied_events.discard(key)
                shutil.rmtree(tmp, ignore_errors=True)

        await client.start(self.token)

    async def _on_gateway_lost(self) -> None:
        client = self._client
        try:
            if client is not None:
                await client.close()
        finally:
            self._client = None
            session, self._audience_session = self._audience_session, None
            if session is not None:
                await session.close()

    # ── Platform primitives (consumed by BaseBridge.dispatch_turn) ──

    def _assert_channel_target(self, channel) -> None:
        current = self._resolve_context()
        if str(getattr(channel, "id", "")) != (current.thread_id or current.conversation_id):
            raise PermissionError("Discord output target differs from its context")

    async def post_status(self, channel, text: str):
        self._assert_channel_target(channel)
        # Native "is writing" indicator instead of a "Thinking…"
        # message. Tool calls + answer spans surface as live step messages
        # (BaseBridge.dispatch_turn live mode); the typing dot covers the
        # gap before the first one lands.
        try:
            animator = _DiscordTypingAnimator(channel)
            await animator.start()
            return animator
        except Exception:
            return None

    async def update_status(self, animator, text: str) -> None:
        # No-op: the native typing indicator + live step messages replace
        # the old edited "…" placeholder.
        return None

    async def clear_status(self, animator) -> None:
        if animator is None:
            return
        try:
            await animator.stop()
        except Exception:
            pass

    async def send_text_chunk(self, channel, chunk: str) -> None:
        self._assert_channel_target(channel)
        try:
            await channel.send(chunk)
        except Exception as e:  # noqa: BLE001
            logger.error("Discord text send error: %s", type(e).__name__)

    async def post_compaction_notice(self, channel):
        self._assert_channel_target(channel)
        # In-place compaction (vision §2): Discord supports message edits,
        # so post one bubble and flip it in place rather than posting a
        # "Compacting…"/"Compacted" pair (see resolve_compaction_notice).
        try:
            return await channel.send("🗜 *Compacting conversation…*")
        except Exception:
            return None

    async def resolve_compaction_notice(self, channel, handle, text, *, ok):
        self._assert_channel_target(channel)
        if handle is None:
            return await super().resolve_compaction_notice(channel, handle, text, ok=ok)
        try:
            await handle.edit(content=text)
        except Exception:
            pass

    def _new_media_session(self):
        import aiohttp
        return aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=_DISCORD_MEDIA_DOWNLOAD_TIMEOUT))

    async def _download_attachment(self, attachment, path, *, context, channel_id, max_bytes=None):
        """Stream only the SDK attachment's fixed Discord CDN target."""
        from urllib.parse import urlsplit
        current = self._resolve_context(context)
        await self._prepare_delivery_context(current)
        parsed = urlsplit(str(getattr(attachment, "url", "")))
        segments = parsed.path.split("/")
        if (parsed.scheme != "https" or parsed.hostname not in {"cdn.discordapp.com", "media.discordapp.net"}
                or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443)
                or parsed.fragment or len(segments) < 5 or segments[1] != "attachments"
                or segments[2] != channel_id or segments[3] != str(attachment.id)
                or channel_id != (current.thread_id or current.conversation_id)):
            raise PermissionError("Discord media source differs from its SDK context")
        limit = attachment_limit_bytes(direction="input")
        if max_bytes is not None:
            if type(max_bytes) is not int or max_bytes <= 0:
                raise ValueError("Historical media byte budget exhausted")
            limit = min(limit, max_bytes) if limit else max_bytes
        declared = int(getattr(attachment, "size", 0) or 0)
        if declared < 0 or limit and declared > limit:
            raise ValueError("Discord media exceeds the byte limit")
        owned = False
        try:
            async with self._new_media_session() as session:
                await self._prepare_delivery_context(current)
                async with session.get(attachment.url, allow_redirects=False) as response:
                    await self._prepare_delivery_context(current)
                    if response.status != 200:
                        raise RuntimeError("Discord media download failed")
                    header_size = int(response.headers.get("Content-Length") or 0)
                    if header_size < 0 or limit and header_size > limit:
                        raise ValueError("Discord media exceeds the byte limit")
                    copied = await write_authorized_download(
                        response.content, path, self._transfer_authorizer(self._resolve_context()), limit=limit)
                    owned = True
                    if header_size and copied != header_size or declared and copied != declared:
                        raise ValueError("Incomplete Discord media download")
            await self._prepare_delivery_context(current)
            return copied
        except BaseException:
            if owned:
                with contextlib.suppress(OSError):
                    Path(path).unlink()
            raise

    async def send_attachment(self, channel, att) -> None:
        """Use the public multipart endpoint so every file chunk is guarded."""
        import aiohttp
        import json
        import mimetypes
        import re
        current = self._resolve_context()
        channel_id = str(channel.id)
        if not channel_id.isdecimal() or channel_id != (current.thread_id or current.conversation_id):
            raise PermissionError("Discord media target differs from context")
        path = Path(att.path)
        limit = attachment_limit_bytes(direction="output")
        snapshot = media_file_snapshot(path, limit=limit)
        filename = safe_attachment_filename(getattr(att, "filename", None) or path.name)
        if is_blocked_attachment(filename):
            raise ValueError("Blocked media filename")
        mime = getattr(att, "mime_type", None) or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if not isinstance(mime, str) or re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+", mime) is None:
            raise ValueError("Invalid media content type")
        caption = getattr(att, "caption", None)
        if caption is not None and (not isinstance(caption, str) or len(caption) > 2000):
            raise ValueError("Discord media caption exceeds the message limit")
        async def authorize():
            await self._prepare_delivery_context(current)
        transferred = 0
        complete = False
        async def upload():
            nonlocal transferred, complete
            async for chunk in authorized_file_chunks(path, authorize, snapshot=snapshot, limit=limit):
                transferred += len(chunk)
                yield chunk
            complete = True
        payload = {"attachments": [{"id": 0, "filename": filename}], "allowed_mentions": {"parse": []}}
        if caption:
            payload["content"] = caption
        form = aiohttp.FormData()
        form.add_field("payload_json", json.dumps(payload), content_type="application/json")
        form.add_field("files[0]", upload(), filename=filename, content_type=mime)
        await authorize()
        async with self._new_media_session() as session:
            await authorize()
            async with session.post(f"https://discord.com/api/v10/channels/{channel_id}/messages",
                    data=form, headers={"Authorization": f"Bot {self.token}"}, allow_redirects=False) as response:
                await authorize()
                if response.status != 200:
                    raise RuntimeError("Discord media publication failed")
                data = await read_authorized_response(response.content, authorize, limit=1 << 20)
                try:
                    result = json.loads(data)
                except (ValueError, UnicodeError):
                    raise RuntimeError("Invalid Discord media response") from None
        await authorize()
        if (not complete or transferred != snapshot[2] or media_file_snapshot(path, limit=limit) != snapshot
                or not isinstance(result, dict) or str(result.get("channel_id", "")) != channel_id
                or not isinstance(result.get("attachments"), list) or len(result["attachments"]) != 1):
            raise RuntimeError("Discord media publication could not be verified")

    async def _handle_slash(self, interaction, cmd: str, *, arg: str | None = None) -> None:
        """Handle a Discord slash command via the Gateway."""
        uid, cid, gid, is_dm = self._interaction_scope(interaction)
        if not self._scope_allowed(uid, cid, gid, is_dm=is_dm):
            await interaction.response.send_message("Unauthorized.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        # Commands in a public guild channel operate on that channel's shared
        # conversation; DM commands remain private to the issuing user.
        # Forward any inline argument (e.g. /model gpt-4o) via the arg field.
        session_id = self._session_id(uid, cid, gid, is_dm=is_dm)
        context = self._bridge_context(interaction)
        result = await self.send_command_full(cmd, session_id=session_id, arg=arg or None,
                                              context=context)
        picker = result.get("picker") if isinstance(result, dict) else None
        if isinstance(picker, dict) and picker.get("options"):
            view = _build_picker_view(self, session_id, picker)
            if view is not None:
                prompt = str(picker.get("prompt") or "Choose:")
                await self._prepare_delivery_context(context)
                await interaction.followup.send(prompt, view=view, ephemeral=True)
                return
        await self._prepare_delivery_context(context)
        await interaction.followup.send(result.get("text", ""), ephemeral=True)

    async def stop(self) -> None:
        try:
            await super().stop()
        finally:
            await self._on_gateway_lost()
