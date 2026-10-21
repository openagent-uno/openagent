"""Standalone compatibility adapter for the shared telegram provider."""
from openagent_channel_bridges import telegram as _provider
from .base import BaseBridge as StandaloneBaseBridge, make_gateway_transport

# Preserve legacy helper imports. Provider implementation remains shared.
for _key, _value in vars(_provider).items():
    if not _key.startswith("__") and _key not in {"TelegramBridge", "BaseBridge"}:
        globals()[_key] = _value


class TelegramBridge(_provider.TelegramBridge, StandaloneBaseBridge):
    def __init__(self, token: str, allowed_users=None,
                 gateway_url="ws://localhost:8765/ws", gateway_token=None,
                 personality=None, streaming=False, allowed_chats=None, live=True,
                 *, transport=None, binding_id="telegram"):
        transport = transport if transport is not None else make_gateway_transport(
            gateway_url, gateway_token, name="telegram", binding_id=binding_id)
        super().__init__(token, allowed_users, personality=personality,
            streaming=streaming, allowed_chats=allowed_chats, live=live,
            transport=transport, binding_id=binding_id)

    async def _get_learning_db_shim(self):
        # Existing standalone export compatibility; never part of shared SDK.
        return await self.transport._get_learning_db_shim()

    async def _on_export(self, update, context) -> None:
        """``/export`` — bundle the user's profile + skills + recent
        turns into a zip and send it back as a Telegram document.
        GDPR-friendly and lets users back up their context between
        deployments. Heavy lifting (DB reads) runs against the cached
        ``_learning_conn`` already opened for the skill matcher."""
        if not self._is_fresh_update(update):
            return
        if not update.message:
            return
        user_id = str(update.message.from_user.id)
        if not self._is_authorized(user_id):
            return await update.message.reply_text("Unauthorized.")
        bridge_context = self._bridge_context(update.message)
        await self.authorize_context(bridge_context)
        import io
        import json as _json
        import zipfile
        session_id = f"tg:{user_id}"
        progress = await update.message.reply_text("📦 Preparo l'export...")
        try:
            shim = await self._get_learning_db_shim()
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                # User profile (the cross-session "who is the user" JSON).
                if shim is not None:
                    try:
                        cur = await shim._conn.execute(
                            "SELECT profile_json, turn_count, last_flushed_at "
                            "FROM user_profiles WHERE session_id = ?",
                            (session_id,),
                        )
                        row = await cur.fetchone()
                        await cur.close()
                    except Exception:
                        row = None
                    if row:
                        zf.writestr(
                            "user_profile.json",
                            _json.dumps(
                                {
                                    "session_id": session_id,
                                    "profile": _json.loads(row[0] or "{}"),
                                    "turn_count": row[1],
                                    "last_flushed_at": row[2],
                                },
                                ensure_ascii=False,
                                indent=2,
                            ),
                        )
                    else:
                        zf.writestr(
                            "user_profile.json",
                            "{}",
                        )
                    # Skills — current implementation has a single global
                    # set per agent; for a personal bot deployment they're
                    # effectively this user's. Future multi-tenant should
                    # filter by user_id.
                    try:
                        cur = await shim._conn.execute(
                            "SELECT id, name, signature_hash, markdown, tags_json, "
                            "       usage_count, last_used_at, created_at "
                            "FROM skills ORDER BY usage_count DESC, last_used_at DESC NULLS LAST"
                        )
                        skills_rows = await cur.fetchall()
                        await cur.close()
                    except Exception:
                        skills_rows = []
                    skills_payload = []
                    for r in skills_rows or []:
                        try:
                            tags = _json.loads(r[4] or "[]")
                        except Exception:
                            tags = []
                        skills_payload.append({
                            "id": r[0],
                            "name": r[1],
                            "signature_hash": r[2],
                            "markdown": r[3],
                            "tags": tags,
                            "usage_count": r[5],
                            "last_used_at": r[6],
                            "created_at": r[7],
                        })
                    zf.writestr(
                        "skills.json",
                        _json.dumps(skills_payload, ensure_ascii=False, indent=2),
                    )
                    # Recent session row (carries the runtime-tracked
                    # turn transcript for this user's session).
                    try:
                        cur = await shim._conn.execute(
                            "SELECT session_data, agent_data, runs, summary, "
                            "       updated_at FROM sessions WHERE session_id = ?",
                            (session_id,),
                        )
                        sess = await cur.fetchone()
                        await cur.close()
                    except Exception:
                        sess = None
                    if sess:
                        zf.writestr(
                            "session.json",
                            _json.dumps(
                                {
                                    "session_id": session_id,
                                    "session_data": sess[0],
                                    "agent_data": sess[1],
                                    "runs": sess[2],
                                    "summary": sess[3],
                                    "updated_at": sess[4],
                                },
                                ensure_ascii=False,
                                indent=2,
                            ),
                        )
                # A friendly README so the user knows what's inside.
                zf.writestr(
                    "README.md",
                    "# OpenAgent export\n\n"
                    f"Export for session `{session_id}` generated at "
                    f"{time.strftime('%Y-%m-%d %H:%M:%S')}.\n\n"
                    "## Files\n\n"
                    "- `user_profile.json` — the cross-session profile the bot keeps about you.\n"
                    "- `skills.json` — reusable how-tos the bot has learned.\n"
                    "- `session.json` — the latest conversation transcript.\n\n"
                    "All data is your property. Use `/clear` in chat to "
                    "wipe the live session at any time.\n",
                )
            buf.seek(0)
            try:
                await progress.delete()
            except Exception:
                pass
            await self.authorize_context(bridge_context)
            await update.message.reply_document(
                document=buf,
                filename=f"openagent-export-{time.strftime('%Y%m%d-%H%M%S')}.zip",
                caption="📦 Ecco i tuoi dati — profilo, skill, ultima sessione.",
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("/export failed: %s", e)
            try:
                await progress.edit_text(f"⚠️ Errore durante l'export: {str(e)[:200]}")
            except Exception:
                pass
