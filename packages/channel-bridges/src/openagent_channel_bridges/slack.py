"""Slack channel adapter for Socket Mode or authenticated external intake.

Mirrors ``bridges/telegram.py`` in shape: subclass :class:`BaseBridge`,
implement platform-specific event polling, delegate orchestration to
``BaseBridge.dispatch_turn``. Socket mode is the right choice for a
self-hosted agent because the bot doesn't need a public HTTP endpoint
— it dials out to Slack's gateway and receives events over WebSocket.

Status indicator: Slack doesn't expose a typing primitive to bots
(unlike Telegram's chat.sendChatAction / Discord's typing()), so there
is no "is writing" flag to set and ``post_status`` is a no-op — the live
step messages (each tool call + answer span) are the progress affordance
instead. We no longer post a ``Thinking…`` placeholder.

Auth needs TWO tokens:
  - ``bot_token`` (``xoxb-...``) — HTTP API auth, set as bot OAuth scope
  - ``app_token`` (``xapp-...``) — socket mode auth, generated from the
    app's Basic Information page after enabling socket mode

These tokens describe operator-managed Socket Mode. External authenticated
intake uses ``handle_event`` with no app-level token and the same host transport.

Wire both via ``channels.slack.{bot_token, app_token}`` in
``openagent.yaml`` (or env vars ``SLACK_BOT_TOKEN`` / ``SLACK_APP_TOKEN``).
``allowed_users`` accepts Slack user_ids (``U…``) — keep small for a
personal bot since DMs are the main use case.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import tempfile
import time
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import BridgeAttachment, BridgeContext, BridgeHistoryMessage, BridgePart
from openagent_channel_bridges.history import bound_history, validate_context_messages
from openagent_channel_bridges.history_media import prepare_history_media
from openagent_core.media import is_blocked_attachment
from openagent_channel_bridges.media import is_audio_file
from openagent_channel_bridges.base import elog
from openagent_channel_bridges.media import (
    attachment_limit_bytes,
    safe_attachment_filename,
    safe_attachment_staging_name,
    authorized_file_chunks, media_file_snapshot, write_authorized_download,
    read_authorized_response, MediaTransferTooLarge,
)

logger = logging.getLogger(__name__)

# Slack hard caps the text field of chat.postMessage at 40_000 chars
# but the practical formatting limit is much lower — long replies are
# split via BaseBridge.message_limit + send_text_chunk.
SLACK_MSG_LIMIT = 3500
_SLACK_MEDIA_DOWNLOAD_TIMEOUT = 120.0


@dataclass(frozen=True)
class _SlackDownloadOutcome:
    path: str | None
    error: str | None = None
    size_bytes: int = 0


def _build_picker_blocks(picker: dict | None) -> list | None:
    """Build Block Kit blocks with a ``static_select`` for a structured
    command picker (e.g. the /model chooser). Returns ``None`` when there
    are no renderable options — the caller then falls back to plain text.

    Each option's value encodes ``<command>::<runtime_id>`` so the shared
    ``oa_cmd_pick`` action handler can re-issue the right command. Slack
    caps a select at 100 options and each value/label at 75 chars.
    """
    if not isinstance(picker, dict):
        return None
    command = str(picker.get("command") or "")
    raw = picker.get("options") or []
    if not command or not raw:
        return None
    options = []
    for opt in raw[:100]:
        value = str(opt.get("value") or "")
        if not value:
            continue
        encoded = f"{command}::{value}"
        if len(encoded) > 75:  # Slack option value hard cap
            continue
        label = str(opt.get("label") or value)
        if opt.get("active"):
            label = f"✓ {label}"
        options.append({
            "text": {"type": "plain_text", "text": label[:75]},
            "value": encoded,
        })
    if not options:
        return None
    prompt = str(picker.get("prompt") or "Choose:")
    return [
        {"type": "section", "text": {"type": "mrkdwn", "text": prompt}},
        {"type": "actions", "elements": [{
            "type": "static_select",
            "action_id": "oa_cmd_pick",
            "placeholder": {"type": "plain_text", "text": "Select…"},
            "options": options,
        }]},
    ]


class SlackBridge(BaseBridge):
    name = "slack"
    message_limit = SLACK_MSG_LIMIT

    def __init__(
        self,
        bot_token: str,
        app_token: str | None = None,
        allowed_users: list[str] | None = None,
        listen_channels: list[str] | None = None,
        personality: str | None = None,
        live: bool | None = None,
        *,
        transport,
        binding_id: str,
        context_messages: int = 20,
        delivery_mode: str | None = None,
        acknowledgement_text: str | None = None,
    ):
        super().__init__(transport=transport, binding_id=binding_id, personality=personality,
                         live=live, delivery_mode=delivery_mode, acknowledgement_text=acknowledgement_text)
        if not isinstance(binding_id, str) or not binding_id:
            raise ValueError("A host-owned binding_id is required")
        self.binding_id = binding_id
        self.context_messages = validate_context_messages(context_messages)
        self._account_id: str | None = None
        self.bot_token = bot_token
        self.app_token = app_token
        self.allowed_users = (
            set(str(u) for u in allowed_users) if allowed_users else None
        )
        if self.allowed_users is None:
            # See the same note in the Telegram bridge: open is a documented
            # choice, but it must be a visible one.
            logger.warning(
                "Slack bridge has no allowed_users: every user who can reach "
                "this app can use the agent. Set channels.slack.allowed_users "
                "to restrict it.",
            )
        self.listen_channels = (
            set(str(c) for c in listen_channels) if listen_channels else None
        )
        self._app: Any = None
        self._socket_handler: Any = None
        self._bot_user_id: str | None = None
        self._download_session = None
        self._event_clients: dict[tuple, Any] = {}
        self._audience_denied_events: set[tuple] = set()

    def _is_authorized(self, user_id: str) -> bool:
        return self.allowed_users is None or user_id in self.allowed_users

    def _bridge_context(self, *, account: str, actor: str, channel: str, event: str,
                 thread: str | None = None, channel_type: str = "") -> BridgeContext:
        if self._account_id and account != self._account_id:
            raise PermissionError("Slack workspace does not match this binding")
        return BridgeContext(self.binding_id, self.name, account, actor, channel,
                             event, thread_id=thread,
                             conversation_kind=("direct" if self._is_dm_channel(channel, channel_type)
                                 else "thread" if thread else "group"
                                 if channel_type == "mpim" else "channel"))

    @staticmethod
    def _event_key(context: BridgeContext) -> tuple:
        return tuple(getattr(context, field) for field in (
            "binding_id", "provider", "account_id", "actor_id", "conversation_id",
            "event_id", "thread_id", "reply_to_event_id", "api_version", "conversation_kind"))

    async def _delivery_context(self, context: BridgeContext) -> BridgeContext:
        # A client belongs to the exact authenticated incoming event. Never let
        # overlapping events borrow another workspace's client or target.
        await self.authorize_context(context)
        if (not self._is_authorized(context.actor_id) or not self._channel_listened(
                context.conversation_id, self._is_dm_channel(context.conversation_id))):
            raise PermissionError("Slack context is no longer admitted")
        client = self._event_clients.get(self._event_key(context))
        if client is None and (self._account_id == context.account_id
                and self._bot_user_id and self._app is not None):
            client = self._app.client  # SDK auth_test verified this binding.
        incomplete = replace(context, audience_ids=(), audience_complete=False,
                             audience_verified_at=None)
        key = self._event_key(context)

        def deny_audience():
            # A failed proof ends this exact turn. Error/status rendering must
            # not repeat a capped scan or turn an incomplete result into output.
            if key in self._event_clients:
                self._audience_denied_events.add(key)
            if context.conversation_kind == "direct":
                raise PermissionError("Slack direct audience cannot be verified")
            return incomplete

        if key in self._audience_denied_events:
            return deny_audience()
        if client is None:
            return deny_audience()
        try:
            await self.authorize_context(context)
            auth = await client.auth_test()
            bot = auth.get("user_id")
            if (auth.get("ok") is False or auth.get("team_id") != context.account_id
                    or not isinstance(bot, str) or not bot
                    or self._bot_user_id is not None and bot != self._bot_user_id):
                raise ValueError("Slack client binding is not verified")
            # Direct-channel metadata comes from the authenticated Web API,
            # not a user-supplied list of audience IDs or a channel ID prefix.
            if context.conversation_kind == "direct" or self._is_dm_channel(context.conversation_id):
                await self.authorize_context(context)
                info = await client.conversations_info(channel=context.conversation_id)
                channel = info.get("channel") or {}
                if (info.get("ok") is False or channel.get("id") != context.conversation_id
                        or channel.get("is_im") is not True or channel.get("user") != context.actor_id):
                    raise ValueError("Slack direct participant cannot be verified")
                await self.authorize_context(context)
                return replace(context, audience_ids=(context.actor_id,), audience_complete=True,
                               audience_verified_at=time.time())
            members: set[str] = set()
            cursor = ""
            cursors: set[str] = set()
            for page in range(10):
                await self.authorize_context(context)
                args = {"channel": context.conversation_id, "limit": 100}
                if cursor:
                    args["cursor"] = cursor
                response = await client.conversations_members(**args)
                values = response.get("members")
                if response.get("ok") is False or not isinstance(values, list) or len(values) > 100:
                    raise ValueError("Slack audience response is invalid")
                for member in values:
                    if not isinstance(member, str) or not member:
                        raise ValueError("Slack audience member is invalid")
                    members.add(member)
                if len(members) > 1000:
                    return deny_audience()
                cursor = str((response.get("response_metadata") or {}).get("next_cursor") or "")
                if not cursor:
                    if response.get("has_more"):
                        return deny_audience()
                    break
                if cursor in cursors or page == 9:
                    return deny_audience()
                cursors.add(cursor)
            if context.actor_id not in members or context.actor_id == bot:
                return deny_audience()
            members.discard(bot)  # Only the SDK auth_test-known self bot.
            await self.authorize_context(context)
            return replace(context, audience_ids=tuple(sorted(members)), audience_complete=True,
                           audience_verified_at=time.time())
        except PermissionError:
            raise
        except Exception as exc:
            logger.warning("Slack audience unavailable: %s", type(exc).__name__)
            return deny_audience()

    async def _history(self, client, context: BridgeContext, *, is_dm: bool, trigger_ts: str,
                       media_directory: str | None = None, current_attachments=()) -> tuple[BridgeHistoryMessage, ...]:
        if not self.context_messages:
            return ()
        if not self._is_authorized(context.actor_id) or not self._channel_listened(context.conversation_id, is_dm):
            raise PermissionError("Slack context is no longer admitted")
        try:
            trigger_time = Decimal(trigger_ts)
            if not trigger_time.is_finite():
                raise InvalidOperation
        except InvalidOperation:
            raise ValueError("Slack message timestamp is invalid") from None
        records = []
        files = {}
        cursor = None
        # Slack replies are oldest-first. Read at most 10 bounded pages; if the
        # end is not reached, omit context rather than mislabel an old prefix
        # as the latest messages. No search/channel fallback is permitted.
        for page in range(10 if context.thread_id else 1):
            await self.authorize_context(context)
            kwargs = {"channel": context.conversation_id, "latest": trigger_ts,
                      "inclusive": False, "limit": 100 if context.thread_id else min(100, self.context_messages + 1)}
            if cursor:
                kwargs["cursor"] = cursor
            try:
                if context.thread_id:
                    response = await client.conversations_replies(ts=context.thread_id, **kwargs)
                else:
                    response = await client.conversations_history(**kwargs)
            except Exception:
                logger.warning("Slack channel context unavailable")
                await self.authorize_context(context)
                return ()
            for message in response.get("messages", [])[:100]:
                event = str(message.get("ts") or "")
                actor = str(message.get("user") or message.get("bot_id") or "")
                try:
                    event_time = Decimal(event)
                except InvalidOperation:
                    continue
                if not event or not actor or not event_time.is_finite() or event_time >= trigger_time:
                    continue
                if message.get("channel", context.conversation_id) != context.conversation_id:
                    continue
                thread = message.get("thread_ts")
                if context.thread_id and event != context.thread_id and thread != context.thread_id:
                    continue
                if not context.thread_id and thread and thread != event:
                    continue
                text = message.get("text")
                parts = [BridgePart(text=text)] if isinstance(text, str) and text and len(text.encode("utf-8")) <= 65536 else []
                for value in (message.get("files") or ())[:16]:
                    if not isinstance(value, dict) or not value.get("id"):
                        continue
                    name = safe_attachment_filename(value.get("name") or value.get("title") or "attachment")
                    mime = str(value.get("mimetype") or "application/octet-stream")
                    kind = "voice" if is_audio_file(name, mime) else "image" if mime.startswith("image/") else "video" if mime.startswith("video/") else "file"
                    attachment = BridgeAttachment(kind, name, mime, max(0, int(value.get("size") or 0)),
                        provider_attachment_id=str(value["id"]))
                    files[(event, attachment.provider_attachment_id)] = value
                    parts.append(BridgePart(attachment=attachment))
                if parts:
                    records.append(BridgeHistoryMessage(event, actor, tuple(parts), timestamp=event))
            cursor = str((response.get("response_metadata") or {}).get("next_cursor") or "")
            if not context.thread_id or not cursor and not response.get("has_more"):
                break
            if not cursor or page == 9:
                logger.warning("Slack thread context omitted: bounded history scan incomplete")
                return ()
        records.sort(key=lambda item: Decimal(item.event_id))
        await self.authorize_context(context)
        selected = bound_history(records, context_messages=self.context_messages, exclude_event_id=trigger_ts)
        async def load(record, attachment, remaining_bytes):
            if media_directory is None or is_blocked_attachment(attachment.filename):
                raise ValueError("Historical media staging unavailable")
            value = files[(record.event_id, attachment.provider_attachment_id)]
            url = str(value.get("url_private_download") or value.get("url_private") or "")
            directory = tempfile.mkdtemp(prefix="history-", dir=media_directory)
            outcome = await self._download_file(url, directory, attachment.filename,
                declared_size=attachment.size_bytes, context=context, max_bytes=remaining_bytes)
            path = outcome if isinstance(outcome, str) else outcome.path
            if not path:
                raise ValueError("Historical Slack media unavailable")
            return replace(attachment, local_path=path, size_bytes=Path(path).stat().st_size)
        selected = await prepare_history_media(self, selected, context, load,
                                               current_attachments=current_attachments)
        return bound_history(selected, context_messages=self.context_messages, exclude_event_id=trigger_ts)

    def _channel_listened(self, channel_id: str, is_dm: bool) -> bool:
        # DMs are always listened to (subject to allowed_users), public
        # channels need an explicit listen_channels entry. This matches
        # the principle-of-least-surprise: a bot you DM should just
        # answer; a bot in a channel should only answer where you put
        # it on purpose.
        if is_dm:
            return True
        if self.listen_channels is None:
            return False
        return channel_id in self.listen_channels

    @staticmethod
    def _is_dm_channel(channel_id: str, channel_type: str = "") -> bool:
        return channel_type == "im" or channel_id.startswith("D")

    @classmethod
    def _session_id(
        cls,
        user_id: str,
        channel_id: str,
        *,
        channel_type: str = "",
    ) -> str:
        if not channel_id or cls._is_dm_channel(channel_id, channel_type):
            return f"sl:{user_id}"
        return f"sl:channel:{channel_id}"

    async def handle_event(self, event: dict, client, *, account_id: str, event_id: str) -> None:
        """Receive a host-verified Slack envelope, independent of Socket Mode.

        The caller authenticates the HTTP/SDK envelope and binds its account and
        event IDs. This method rechecks host authorization; it does not verify
        arbitrary HTTP signatures or infer authority from a gateway session ID.
        """
        # Filter out bot echo, edits, joins, etc.
        subtype = event.get("subtype")
        if event.get("bot_id") or subtype not in {None, "file_share"}:
            return
        user_id = event.get("user")
        channel_id = event.get("channel")
        channel_type = event.get("channel_type") or ""
        is_dm = self._is_dm_channel(str(channel_id or ""), channel_type)
        text = (event.get("text") or "").strip()
        if not user_id or not channel_id:
            return
        if user_id == self._bot_user_id:
            return
        if not self._is_authorized(str(user_id)):
            return
        if not self._channel_listened(str(channel_id), is_dm):
            return
        if event.get("team") not in {None, account_id}:
            raise PermissionError("Slack event workspace differs from its verified envelope")
        if not is_dm:
            mention = f"<@{self._bot_user_id}>" if self._bot_user_id else None
            if event.get("type") != "app_mention" and (mention is None or mention not in text):
                return
            if mention is not None and mention not in text:
                return
        bridge_context = self._bridge_context(
            account=account_id,
            actor=str(user_id), channel=str(channel_id), event=event_id,
            thread=str(event["thread_ts"]) if event.get("thread_ts") else None, channel_type=channel_type,
        )
        await self.authorize_context(bridge_context)
        # Strip a leading <@BOTID> mention so the model doesn't see
        # the noise; for DMs the mention isn't usually present.
        if self._bot_user_id:
            mention = f"<@{self._bot_user_id}>"
            if text.startswith(mention):
                text = text[len(mention):].lstrip(": ").strip()

        tmp = tempfile.mkdtemp(prefix="oa_sl_")
        attachments: list[dict] = []
        voice_detected = False
        session_id = self._session_id(
            str(user_id), str(channel_id), channel_type=channel_type,
        )
        reply_thread = event.get("thread_ts") or None
        key = self._event_key(bridge_context)
        if key in self._event_clients:
            shutil.rmtree(tmp, ignore_errors=True)
            raise PermissionError("Slack event is already active")
        self._event_clients[key] = client
        try:
            bridge_context = await self._prepare_delivery_context(bridge_context)
            async def _notify_attachment(message: str) -> None:
                kwargs = {"channel": channel_id, "text": message}
                if reply_thread:
                    kwargs["thread_ts"] = reply_thread
                await self._prepare_delivery_context(bridge_context)
                with contextlib.suppress(Exception):
                    await client.chat_postMessage(**kwargs)

            for file_info in event.get("files") or ():
                if not isinstance(file_info, dict):
                    continue
                filename = safe_attachment_filename(
                    file_info.get("name")
                    or file_info.get("title")
                    or f"slack-{file_info.get('id') or 'file'}"
                )
                if is_blocked_attachment(filename):
                    await _notify_attachment(f"⚠️ Blocked: {filename}")
                    continue
                url = str(
                    file_info.get("url_private_download")
                    or file_info.get("url_private")
                    or ""
                )
                if not url:
                    await _notify_attachment(
                        f"⚠️ Impossibile scaricare {filename}. Riprova più tardi."
                    )
                    continue
                raw_outcome = await self._download_file(
                    url,
                    tmp,
                    filename,
                    declared_size=int(file_info.get("size") or 0),
                    context=bridge_context,
                )
                # Private method compatibility for bridge subclasses/tests
                # written before structured failure reasons were added.
                if isinstance(raw_outcome, str):
                    outcome = _SlackDownloadOutcome(path=raw_outcome)
                elif isinstance(raw_outcome, _SlackDownloadOutcome):
                    outcome = raw_outcome
                else:
                    outcome = _SlackDownloadOutcome(
                        path=None,
                        error="download_failed",
                    )
                if outcome.path is None:
                    if outcome.error == "too_large":
                        limit = attachment_limit_bytes(direction="input")
                        elog(
                            "bridge.slack.attachment_rejected",
                            level="warning",
                            filename=filename,
                            size_bytes=outcome.size_bytes,
                            limit_bytes=limit,
                        )
                        await _notify_attachment(
                            f"⚠️ File troppo grande: {filename} "
                            f"({outcome.size_bytes} byte; limite {limit} byte)."
                        )
                    else:
                        await _notify_attachment(
                            f"⚠️ Impossibile scaricare {filename}. Riprova più tardi."
                        )
                    continue
                path = outcome.path
                mime = str(file_info.get("mimetype") or "") or None
                voice = is_audio_file(filename, mime)
                kind = (
                    "voice" if voice
                    else "image" if str(mime or "").startswith("image/")
                    else "video" if str(mime or "").startswith("video/")
                    else "file"
                )
                attachments.append({
                    "type": kind,
                    "kind": kind,
                    "path": path,
                    "filename": filename,
                    "mime_type": mime,
                    "size_bytes": Path(path).stat().st_size,
                    "provider_attachment_id": str(file_info["id"]) if file_info.get("id") is not None else None,
                })
                if voice:
                    voice_detected = True
                    speech_context = await self._prepare_delivery_context(bridge_context)
                    transcript = await self.transcribe_with_fallback(path, context=speech_context,
                        attachment=BridgeAttachment(kind=kind, filename=filename, mime_type=mime,
                            size_bytes=Path(path).stat().st_size, local_path=path,
                            provider_attachment_id=str(file_info["id"]) if file_info.get("id") is not None else None))
                    await self._prepare_delivery_context(bridge_context)
                    text = f"{text}\n{transcript}" if text else transcript

            if not text and not attachments:
                return
            # Bridge target carries the SDK client + channel for platform
            # primitives.  Keep replies in an existing Slack thread.
            target = _SlackTarget(
                client=client,
                channel=channel_id,
                user=user_id,
                thread_ts=reply_thread,
            )
            history = await self._history(client, bridge_context, is_dm=is_dm, trigger_ts=str(event.get("ts") or ""),
                                          media_directory=tmp, current_attachments=attachments)
            await self.dispatch_turn(
                target,
                session_id,
                text,
                context=bridge_context,
                history=history,
                voice_detected=voice_detected,
                attachments=attachments,
                author={
                    "kind": "human",
                    "handle": f"slack:{user_id}",
                    "display": str(user_id),
                },
            )
        except Exception as e:  # noqa: BLE001
            logger.error("slack dispatch failed: %s", type(e).__name__)
            elog("bridge.error", name="slack", session_id=session_id, error_type=type(e).__name__)
        finally:
            self._event_clients.pop(key, None)
            self._audience_denied_events.discard(key)
            shutil.rmtree(tmp, ignore_errors=True)


    async def _run(self) -> None:
        if self.app_token is None:
            # External host ingress owns intake; BaseBridge.stop cancels this
            # idle task. No Socket Mode app/token is required for that path.
            await self._gateway_lost.wait()
            return
        try:
            from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler
            from slack_bolt.async_app import AsyncApp
        except ImportError as e:
            logger.error("slack bridge needs 'slack-bolt' installed (%s)", type(e).__name__)
            elog("bridge.error", name="slack", error="slack_bolt not installed")
            return

        app = AsyncApp(token=self.bot_token)
        self._app = app

        # Resolve bot user id so we can ignore self-replies.
        try:
            auth = await app.client.auth_test()
            self._bot_user_id = auth["user_id"]
            self._account_id = str(auth.get("team_id") or "") or None
        except Exception as e:  # noqa: BLE001
            logger.warning("slack auth_test failed: %s", type(e).__name__)

        @app.event("message")  # type: ignore[misc]
        async def _on_message(event, say, body, client):
            if not self._is_dm_channel(str(event.get("channel") or ""), str(event.get("channel_type") or "")):
                return  # Public mentions have their own event; avoid duplicate turns.
            await self.handle_event(event, client,
                account_id=str(body.get("team_id") or event.get("team") or self._account_id or ""),
                event_id=str(body.get("event_id") or event.get("ts") or ""))

        @app.event("app_mention")  # type: ignore[misc]
        async def _on_mention(event, body, client):
            await self.handle_event(event, client,
                account_id=str(body.get("team_id") or event.get("team") or self._account_id or ""),
                event_id=str(body.get("event_id") or event.get("ts") or ""))

        # Native Slack slash commands, delivered over socket mode (no
        # public request URL needed). Mirrors Telegram's bot commands and
        # Discord's app commands: /stop cancels the issuing user's running
        # turn, /clear|/new|/reset wipe + restart it, /status reports
        # state — all scoped to ``sl:<user_id>`` so one user's command
        # can't touch another's conversation. Slack only delivers these
        # once the user adds them under the app's Features → Slash Commands
        # (socket mode then routes them here). Without that registration
        # Slack swallows ``/stop`` as an "unknown command" and never hands
        # it to the bot — which is why the previous text-only handler could
        # not implement stop on Slack.
        from openagent_channel_bridges.commands import BOT_COMMANDS

        def _make_slash_handler(command_name: str):
            async def _handler(ack, command, respond):  # noqa: ANN001
                await ack()
                uid = str(command.get("user_id") or "")
                if not self._is_authorized(uid):
                    await respond("Unauthorized.")
                    return
                bridge_context = None
                try:
                    # Slack puts any text after the command name in
                    # command["text"] (e.g. "/model gpt-4o" → "gpt-4o").
                    slack_arg = (command.get("text") or "").strip() or None
                    channel_id = str(command.get("channel_id") or "")
                    channel_type = (
                        "im" if str(command.get("channel_name") or "") == "directmessage"
                        else ""
                    )
                    if not self._channel_listened(channel_id, self._is_dm_channel(channel_id, channel_type)):
                        return
                    session_id = self._session_id(
                        uid, channel_id, channel_type=channel_type,
                    )
                    bridge_context = self._bridge_context(account=str(command.get("team_id") or self._account_id or ""),
                        actor=uid, channel=channel_id, event=str(command.get("trigger_id") or ""))
                    result = await self.send_command_full(
                        command_name, session_id=session_id, arg=slack_arg,
                        context=bridge_context,
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("slack /%s failed: %s", command_name, type(e).__name__)
                    if bridge_context is not None:
                        await self._prepare_delivery_context(bridge_context)
                        await respond(f"/{command_name} failed.")
                    return
                await self._prepare_delivery_context(bridge_context)
                picker = result.get("picker") if isinstance(result, dict) else None
                blocks = _build_picker_blocks(picker) if isinstance(picker, dict) else None
                if blocks:
                    await respond(text=str(picker.get("prompt") or "Choose:"), blocks=blocks)
                else:
                    await respond(result.get("text", "") or f"/{command_name} done.")
            return _handler

        for _cmd_name, _ in self.supported_commands:
            app.command(f"/{_cmd_name}")(_make_slash_handler(_cmd_name))

        # Block Kit picker selection (e.g. /model). The static_select's
        # value encodes ``<command>::<runtime_id>``; re-issue the command
        # and replace the picker message with the result. Registered once
        # for the shared action_id used by ``_build_picker_blocks``.
        @app.action("oa_cmd_pick")  # type: ignore[misc]
        async def _on_pick(ack, body, respond):  # noqa: ANN001
            await ack()
            uid = str((body.get("user") or {}).get("id") or "")
            if not self._is_authorized(uid):
                return
            try:
                selected = body["actions"][0]["selected_option"]["value"]
            except (KeyError, IndexError, TypeError):
                return
            command, _, value = selected.partition("::")
            if not command or not value:
                return
            bridge_context = None
            try:
                channel = body.get("channel") or {}
                container = body.get("container") or {}
                channel_id = str(
                    channel.get("id")
                    or container.get("channel_id")
                    or ""
                )
                if not self._channel_listened(channel_id, self._is_dm_channel(channel_id)):
                    return
                session_id = self._session_id(uid, channel_id)
                team = body.get("team") or {}
                bridge_context = self._bridge_context(account=str(team.get("id") or self._account_id or ""),
                    actor=uid, channel=channel_id, event=str(body.get("trigger_id") or ""),
                    thread=str(container["thread_ts"]) if container.get("thread_ts") else None)
                result = await self.send_command(
                    command, session_id=session_id, arg=value,
                    context=bridge_context,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("slack picker /%s failed: %s", command, type(e).__name__)
                result = f"/{command} failed."
            if bridge_context is None:
                return
            await self._prepare_delivery_context(bridge_context)
            with contextlib.suppress(Exception):
                await respond(text=result or "Done.", replace_original=True)

        # Socket mode handler — long-lived; cancellation comes from
        # BaseBridge.stop() which sets _should_stop and cancels the
        # listener task.
        self._socket_handler = AsyncSocketModeHandler(app, self.app_token)
        try:
            await self._socket_handler.start_async()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            elog("bridge.error", name="slack", error_type=type(e).__name__)
            raise

    async def stop(self) -> None:
        # Close the slack-bolt socket-mode connection + aiohttp session
        # BEFORE the BaseBridge teardown cancels the ``_run`` task — the
        # base ``stop()`` never knew about the platform handler, so without
        # this the socket-mode websocket and its session leaked on every
        # shutdown / config reload (``_shutdown_platform`` was dead code).
        self._should_stop = True
        await self._shutdown_platform()
        await super().stop()
        if self._download_session is not None:
            await self._download_session.close()
            self._download_session = None

    async def _shutdown_platform(self) -> None:
        # Close the socket mode connection cleanly so the websocket and its
        # aiohttp session don't leak. Invoked from ``stop()`` above.
        if self._socket_handler is not None:
            with contextlib.suppress(Exception):
                await self._socket_handler.close_async()
            self._socket_handler = None
        if self._app is not None:
            with contextlib.suppress(Exception):
                await self._app.client.session.close()
            self._app = None

    # ── Platform primitives consumed by BaseBridge.dispatch_turn ──

    async def post_status(self, target, text: str):
        # Slack exposes no native bot typing indicator, so there is no
        # "is writing" flag to set and we deliberately do NOT post a
        # "Thinking…" placeholder message. The live step messages (each
        # tool call + answer span, BaseBridge.dispatch_turn live mode)
        # are the progress affordance instead. Returns None — nothing to
        # update or clear.
        return None

    # update_status / clear_status inherit the BaseBridge no-op defaults:
    # there is no placeholder to edit or delete.

    async def send_text_chunk(self, target, chunk: str) -> None:
        # Slack mrkdwn is close enough to plain markdown that the
        # telegram HTML renderer would over-quote things. Send raw text
        # — Slack auto-linkifies URLs and respects \n for paragraphs.
        current = self._resolve_context()
        if str(target.channel) != current.conversation_id or target.thread_ts != current.thread_id:
            raise PermissionError("Slack text destination differs from context")
        try:
            kwargs = {"channel": target.channel, "text": chunk}
            if target.thread_ts:
                kwargs["thread_ts"] = target.thread_ts
            await target.client.chat_postMessage(**kwargs)
        except Exception as e:  # noqa: BLE001
            logger.warning("slack send_text_chunk failed: %s", type(e).__name__)

    async def send_attachment(self, target, att) -> None:
        """Stage guarded bytes, then explicitly publish the exact Slack file.

        Public external-upload APIs keep completion separate from byte transfer.
        They require the host's existing files:write grant; no scope is added.
        """
        import aiohttp
        current = self._resolve_context()
        if str(target.channel) != current.conversation_id:
            raise PermissionError("Slack media target differs from context")
        if target.thread_ts != current.thread_id:
            raise PermissionError("Slack media thread differs from context")
        path = Path(att.path)
        limit = attachment_limit_bytes(direction="output")
        snapshot = media_file_snapshot(path, limit=limit)
        filename = safe_attachment_filename(getattr(att, "filename", None) or path.name)
        if is_blocked_attachment(filename):
            raise ValueError("Blocked media filename")
        async def authorize():
            await self._prepare_delivery_context(current)
        await authorize()
        slot = await target.client.files_getUploadURLExternal(filename=filename, length=snapshot[2])
        await authorize()
        upload_url, file_id = slot.get("upload_url"), slot.get("file_id")
        parsed = urlparse(upload_url) if isinstance(upload_url, str) else None
        if (slot.get("ok") is not True or not isinstance(file_id, str) or not file_id
                or parsed is None or parsed.scheme != "https" or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 443) or parsed.fragment
                or not (parsed.hostname == "slack.com" or str(parsed.hostname or "").endswith(".slack.com"))):
            raise ValueError("Slack upload destination is invalid")
        session = await self._audio_session()
        await authorize()
        transferred = 0
        source = authorized_file_chunks(path, authorize, snapshot=snapshot, limit=limit)
        body = None
        try:
            # With Content-Length, a receiver can acknowledge the final bytes
            # before aiohttp resumes the producer. Drain/validate the source
            # before the last yield instead of relying on generator exhaustion
            # after that acknowledgement. At most two bounded chunks are held.
            first = await anext(source, None)
            complete = first is None
            async def upload():
                nonlocal transferred, complete
                chunk = first
                while chunk is not None:
                    following = await anext(source, None)
                    await authorize()
                    if media_file_snapshot(path, limit=limit) != snapshot:
                        raise ValueError("Media file changed during transfer")
                    complete = following is None
                    transferred += len(chunk)
                    yield chunk
                    chunk = following
            body = upload()
            # No reusable bot authorization is forwarded to the pre-signed URL.
            async with session.post(upload_url,
                    data=body,
                    headers={"Content-Type": "application/octet-stream", "Content-Length": str(snapshot[2])},
                    allow_redirects=False, timeout=aiohttp.ClientTimeout(total=_SLACK_MEDIA_DOWNLOAD_TIMEOUT)) as response:
                if response.status != 200:
                    raise RuntimeError("Slack media byte upload failed")
                await read_authorized_response(response.content, authorize)
        finally:
            if body is not None:
                await body.aclose()
            await source.aclose()
        await authorize()
        if not complete or transferred != snapshot[2]:
            raise RuntimeError("Slack media byte upload was incomplete")
        if media_file_snapshot(path, limit=limit) != snapshot:
            raise ValueError("Media file changed before publication")
        arguments = {"files": [{"id": file_id, "title": filename}], "channel_id": target.channel}
        if getattr(att, "caption", None):
            arguments["initial_comment"] = att.caption
        if target.thread_ts:
            arguments["thread_ts"] = target.thread_ts
        await authorize()
        result = await target.client.files_completeUploadExternal(**arguments)
        await authorize()
        if result.get("ok") is not True:
            raise RuntimeError("Slack media publication failed")

    async def _audio_session(self):
        """Provider-owned download client; never selects a voice backend."""
        if self._download_session is None or self._download_session.closed:
            import aiohttp
            self._download_session = aiohttp.ClientSession()
        return self._download_session

    async def _download_file(
        self,
        url: str,
        tmp: str,
        filename: str,
        *,
        declared_size: int = 0,
        context: BridgeContext | None = None,
        max_bytes: int | None = None,
    ) -> _SlackDownloadOutcome:
        """Fetch a private Slack file using bot auth and a strict byte cap."""

        current = self._resolve_context(context)
        await self._prepare_delivery_context(current)
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443) or parsed.fragment or not (
            parsed.hostname == "slack.com"
            or str(parsed.hostname or "").endswith(".slack.com")
        ):
            elog(
                "bridge.slack.attachment_rejected",
                level="warning",
                reason="unexpected_host",
            )
            return _SlackDownloadOutcome(path=None, error="download_failed")
        limit = attachment_limit_bytes(direction="input")
        if max_bytes is not None:
            if type(max_bytes) is not int or max_bytes <= 0:
                return _SlackDownloadOutcome(path=None, error="too_large")
            limit = min(limit, max_bytes) if limit else max_bytes
        if declared_size < 0:
            return _SlackDownloadOutcome(path=None, error="download_failed")
        if limit and declared_size > limit:
            return _SlackDownloadOutcome(
                path=None, error="too_large", size_bytes=declared_size,
            )
        session = await self._audio_session()
        if session is None:
            return _SlackDownloadOutcome(path=None, error="download_failed")
        target = Path(tmp) / safe_attachment_staging_name(
            safe_attachment_filename(Path(parsed.path).stem, fallback="slack"),
            filename,
        )
        copied = 0
        owned_download = False
        try:
            import aiohttp

            timeout = aiohttp.ClientTimeout(total=_SLACK_MEDIA_DOWNLOAD_TIMEOUT)
            await self._prepare_delivery_context(current)
            async with session.get(
                url,
                headers={"Authorization": f"Bearer {self.bot_token}"},
                timeout=timeout,
                allow_redirects=False,
            ) as response:
                if response.status != 200:
                    return _SlackDownloadOutcome(path=None, error="download_failed")
                await self._prepare_delivery_context(current)
                header_size = int(response.headers.get("Content-Length") or 0)
                if header_size < 0:
                    raise ValueError("Invalid media length")
                if limit and header_size > limit:
                    return _SlackDownloadOutcome(path=None, error="too_large", size_bytes=header_size)
                copied = await write_authorized_download(
                    response.content, target, lambda: self._prepare_delivery_context(current), limit=limit)
                owned_download = True
                if header_size and copied != header_size or declared_size and copied != declared_size:
                    raise ValueError("Incomplete Slack media download")
            await self._prepare_delivery_context(current)
            return _SlackDownloadOutcome(
                path=str(target.resolve()), size_bytes=copied,
            )
        except BaseException as exc:
            with contextlib.suppress(OSError):
                if owned_download and target.is_file() and not target.is_symlink():
                    target.unlink()
            if isinstance(exc, (PermissionError, asyncio.CancelledError)):
                raise
            if isinstance(exc, MediaTransferTooLarge):
                return _SlackDownloadOutcome(path=None, error="too_large", size_bytes=exc.size_bytes)
            elog(
                "bridge.slack.attachment_download_failed",
                level="warning",
                filename=filename,
                error_type=type(exc).__name__,
            )
            return _SlackDownloadOutcome(path=None, error="download_failed")


class _SlackTarget:
    """Bag of what ``BaseBridge`` primitives need from a Slack event.

    Kept slim on purpose — the message object passed around between
    ``post_status`` / ``send_text_chunk`` / ``send_attachment`` only
    needs the SDK client + the channel id. No need to drag the full
    Bolt ``event`` payload through dispatch.
    """

    __slots__ = ("client", "channel", "user", "thread_ts")

    def __init__(
        self, client, channel: str, user: str, thread_ts: str | None = None,
    ):
        self.client = client
        self.channel = channel
        self.user = user
        self.thread_ts = thread_ts
