"""Discord channel adapter using the host's explicitly supplied transport.

Registers native Discord slash commands and handles messages via
the same authorized host runtime. Provider context does not grant host access.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import tempfile
import time
from dataclasses import replace
from pathlib import Path

from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import BridgeContext, BridgeHistoryMessage, BridgePart
from openagent_channel_bridges.history import bound_history, validate_context_messages
from openagent_core.media import is_blocked_attachment
from openagent_channel_bridges.media import is_audio_file
from openagent_channel_bridges.commands import BOT_COMMANDS, bridge_welcome_text
from openagent_channel_bridges.media import (
    attachment_limit_bytes,
    safe_attachment_filename,
    safe_attachment_staging_name,
)

from openagent_channel_bridges.base import elog

logger = logging.getLogger(__name__)

DISCORD_MSG_LIMIT = 2000
_DISCORD_MEDIA_DOWNLOAD_TIMEOUT = 120.0


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
        live: bool = True,
        *,
        transport,
        binding_id: str,
        context_messages: int = 20,
        members_intent: bool = False,
    ):
        super().__init__(transport=transport, binding_id=binding_id, personality=personality, live=live)
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

    def _bridge_context(self, message) -> BridgeContext:
        actor = getattr(message, "author", None) or getattr(message, "user", None)
        channel = message.channel
        guild = getattr(message, "guild", None)
        account = str(guild.id) if guild else str(getattr(getattr(self._client, "user", None), "id", ""))
        thread = str(channel.id) if getattr(channel, "parent_id", None) is not None else None
        reference = getattr(message, "reference", None)
        reply = str(reference.message_id) if getattr(reference, "message_id", None) is not None else None
        return BridgeContext(self.binding_id, self.name, account, str(actor.id),
                             str(channel.id), str(message.id), thread_id=thread,
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
            # Private-thread membership and group DMs have different visibility
            # semantics. Until a complete REST proof exists, never use a cache
            # or parent-channel membership as their audience.
            if context.conversation_kind != "channel" or context.thread_id is not None:
                return deny_audience()
            if not self.members_intent or getattr(getattr(client, "intents", None), "members", False) is not True:
                return deny_audience()
            await self.authorize_context(context)
            guild = await client.fetch_guild(int(context.account_id))
            if str(guild.id) != context.account_id:
                return deny_audience()
            # REST guild metadata includes current roles; REST channel metadata
            # includes current permission overwrites. Cached guild/channel/member
            # objects must not silently turn into a complete audience snapshot.
            await self.authorize_context(context)
            channel = await guild.fetch_channel(int(context.conversation_id))
            if (str(channel.id) != context.conversation_id
                    or str(getattr(getattr(channel, "guild", None), "id", "")) != context.account_id
                    or self._conversation_kind(channel, guild) != "channel"):
                return deny_audience()
            await self.authorize_context(context)
            audience: set[str] = set()
            seen: set[str] = set()
            count = 0
            iterator = guild.fetch_members(limit=1001).__aiter__()
            while True:
                # The SDK may request another REST page on any next item.
                # Reauthorize before advancing it, not merely before page one.
                await self.authorize_context(context)
                try:
                    member = await anext(iterator)
                except StopAsyncIteration:
                    break
                count += 1
                member_id = str(member.id)
                if count > 1000 or member_id in seen:
                    return deny_audience()
                seen.add(member_id)
                if str(getattr(getattr(member, "guild", None), "id", "")) != context.account_id:
                    return deny_audience()
                permissions = channel.permissions_for(member)
                can_view = getattr(permissions, "view_channel", None)
                if type(can_view) is not bool:
                    return deny_audience()
                if can_view and member_id != str(bot):
                    audience.add(member_id)
            if context.actor_id not in audience:
                return deny_audience()
            await self.authorize_context(context)
            return replace(context, audience_ids=tuple(sorted(audience)), audience_complete=True,
                           audience_verified_at=time.time())
        except PermissionError:
            raise
        except Exception as exc:
            logger.warning("Discord audience unavailable: %s", type(exc).__name__)
            return deny_audience()

    async def _history(self, message, context: BridgeContext) -> tuple[BridgeHistoryMessage, ...]:
        if not self.context_messages:
            return ()
        guild = getattr(message, "guild", None)
        gid = str(guild.id) if guild else None
        if not self._scope_allowed(context.actor_id, context.conversation_id, gid, is_dm=guild is None):
            raise PermissionError("Discord context is no longer admitted")
        await self.authorize_context(context)
        records = []
        # A Thread is itself the exact channel object. Never follow references
        # into another channel or fetch from a guild-wide search endpoint.
        try:
            async for item in message.channel.history(limit=min(100, self.context_messages + 1), before=message, oldest_first=False):
                if str(getattr(getattr(item, "channel", None), "id", "")) != context.conversation_id:
                    continue
                item_guild = getattr(item, "guild", None)
                if (str(item_guild.id) if item_guild else None) != gid or str(item.id) == context.event_id:
                    continue
                if int(item.id) >= int(message.id):
                    continue
                text = getattr(item, "content", None)
                actor = str(getattr(getattr(item, "author", None), "id", ""))
                if isinstance(text, str) and text and actor:
                    timestamp = getattr(item, "created_at", None)
                    records.append(BridgeHistoryMessage(str(item.id), actor, (BridgePart(text=text),),
                        timestamp=timestamp.isoformat() if timestamp else None))
        except Exception:
            # Missing optional history permission must not request more scopes
            # or fall back to a broader channel. The current message still works.
            logger.warning("Discord channel context unavailable")
            records = []
        records.sort(key=lambda item: int(item.event_id))
        await self.authorize_context(context)
        return bound_history(records, context_messages=self.context_messages, exclude_event_id=context.event_id)

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
            cid = str(getattr(message.channel, "id", "")) or None
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
            try:
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
                        await self.authorize_context(bridge_context)
                        await asyncio.wait_for(
                            att.save(str(path)),
                            timeout=_DISCORD_MEDIA_DOWNLOAD_TIMEOUT,
                        )
                        await self.authorize_context(bridge_context)
                        actual_size = path.stat().st_size
                        if limit and actual_size > limit:
                            with contextlib.suppress(OSError):
                                path.unlink()
                            blocked.append(f"{filename} (too large)")
                            continue
                    except Exception as exc:  # noqa: BLE001
                        with contextlib.suppress(OSError):
                            path.unlink()
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
                        t = await self.transcribe_with_fallback(str(path), context=bridge_context)
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
                    self._session_id(uid, cid, gid, is_dm=is_dm),
                    content,
                    context=bridge_context,
                    history=await self._history(message, bridge_context),
                    voice_detected=voice_detected,
                    attachments=attachments,
                    author={
                        "kind": "human",
                        "handle": f"discord:{uid}",
                        "display": display,
                    },
                )
            finally:
                self._event_clients.pop(key, None)
                self._audience_denied_events.discard(key)
                shutil.rmtree(tmp, ignore_errors=True)

        await client.start(self.token)

    async def _on_gateway_lost(self) -> None:
        client = self._client
        if client is None:
            return
        try:
            await client.close()
        finally:
            self._client = None

    # ── Platform primitives (consumed by BaseBridge.dispatch_turn) ──

    async def post_status(self, channel, text: str):
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
        try:
            await channel.send(chunk)
        except Exception as e:  # noqa: BLE001
            logger.error("Discord text send error: %s", type(e).__name__)

    async def post_compaction_notice(self, channel):
        # In-place compaction (vision §2): Discord supports message edits,
        # so post one bubble and flip it in place rather than posting a
        # "Compacting…"/"Compacted" pair (see resolve_compaction_notice).
        try:
            return await channel.send("🗜 *Compacting conversation…*")
        except Exception:
            return None

    async def resolve_compaction_notice(self, channel, handle, text, *, ok):
        if handle is None:
            return await super().resolve_compaction_notice(channel, handle, text, ok=ok)
        try:
            await handle.edit(content=text)
        except Exception:
            pass

    async def send_attachment(self, channel, att) -> None:
        import discord as _dc
        p = Path(att.path)
        if not p.exists():
            return
        try:
            await channel.send(file=_dc.File(str(p), filename=att.filename))
        except Exception as e:  # noqa: BLE001
            logger.error("Discord file send error: %s", type(e).__name__)

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
        self._should_stop = True
        if self._client:
            try:
                await self._client.close()
            finally:
                self._client = None
        await super().stop()
