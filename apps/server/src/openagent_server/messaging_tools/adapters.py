"""Native messaging tools supplied by the standalone product.

Channel credentials belong to the host product, so this capability is built
from the verified product environment instead of launching a core-owned MCP
subprocess.  The public tool names remain compatible with existing workflows.
"""
from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx


_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def _file_source(path: str | None, url: str | None) -> tuple[str, str]:
    local = (path or "").strip()
    remote = (url or "").strip()
    if bool(local) == bool(remote):
        raise ValueError("Provide exactly one of path or url")
    if remote:
        if urlparse(remote).scheme not in {"http", "https"}:
            raise ValueError("url must use http or https")
        return "url", remote
    resolved = Path(local).expanduser().resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"path is not a regular file: {resolved}")
    return "path", str(resolved)


async def _json_post(url: str, *, json: dict[str, Any] | None = None,
                     data: dict[str, str] | None = None,
                     files: dict[str, tuple[str, bytes, str]] | None = None,
                     headers: dict[str, str] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as client:
        response = await client.post(url, json=json, data=data, files=files, headers=headers)
        response.raise_for_status()
        return response.json()


def build_runtime_toolkit(*, env: dict[str, str] | None = None) -> Any:
    """Return the messaging tools enabled by the host-supplied credentials."""
    from openagent_core.mcp._runtime import Toolkit

    values = dict(env or {})
    telegram = values.get("TELEGRAM_BOT_TOKEN", "").strip()
    discord = values.get("DISCORD_BOT_TOKEN", "").strip()
    wa_id = values.get("GREEN_API_ID", "").strip()
    wa_token = values.get("GREEN_API_TOKEN", "").strip()
    toolkit = Toolkit(name="messaging")

    async def messaging_status() -> dict[str, Any]:
        """Return the messaging platforms available to this standalone agent."""
        return {
            "telegram": {"enabled": bool(telegram)},
            "discord": {"enabled": bool(discord)},
            "whatsapp": {"enabled": bool(wa_id and wa_token)},
        }

    toolkit.register(messaging_status)

    if telegram:
        async def telegram_send_message(chat_id: str, text: str,
                                        parse_mode: str | None = None) -> Any:
            """Send a text message to a Telegram chat or username."""
            body: dict[str, Any] = {"chat_id": chat_id, "text": text}
            if parse_mode:
                body["parse_mode"] = parse_mode
            return await _json_post(
                f"https://api.telegram.org/bot{telegram}/sendMessage", json=body
            )

        async def telegram_send_file(chat_id: str, path: str | None = None,
                                     url: str | None = None,
                                     caption: str | None = None,
                                     type: str = "document") -> Any:
            """Send one local file or public URL to a Telegram chat."""
            kind, source = _file_source(path, url)
            mapping = {
                "photo": ("sendPhoto", "photo"),
                "voice": ("sendVoice", "voice"),
                "video": ("sendVideo", "video"),
                "document": ("sendDocument", "document"),
            }
            if type not in mapping:
                raise ValueError("type must be photo, voice, video, or document")
            method, field = mapping[type]
            endpoint = f"https://api.telegram.org/bot{telegram}/{method}"
            if kind == "url":
                return await _json_post(endpoint, json={
                    "chat_id": chat_id, field: source, "caption": caption,
                })
            file_path = Path(source)
            mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            return await _json_post(
                endpoint,
                data={"chat_id": chat_id, **({"caption": caption} if caption else {})},
                files={field: (file_path.name, file_path.read_bytes(), mime)},
            )

        toolkit.register(telegram_send_message)
        toolkit.register(telegram_send_file)

    if discord:
        headers = {"Authorization": f"Bot {discord}"}

        async def discord_send_message(channel_id: str, text: str) -> Any:
            """Send a text message to a Discord channel."""
            return await _json_post(
                f"https://discord.com/api/v10/channels/{channel_id}/messages",
                json={"content": text}, headers=headers,
            )

        async def discord_send_file(channel_id: str, path: str | None = None,
                                    url: str | None = None,
                                    text: str | None = None) -> Any:
            """Send one local file or public URL to a Discord channel."""
            kind, source = _file_source(path, url)
            endpoint = f"https://discord.com/api/v10/channels/{channel_id}/messages"
            if kind == "url":
                content = "\n".join(part for part in (text, source) if part)
                return await _json_post(endpoint, json={"content": content}, headers=headers)
            file_path = Path(source)
            mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            return await _json_post(
                endpoint, data={"content": text or ""}, headers=headers,
                files={"files[0]": (file_path.name, file_path.read_bytes(), mime)},
            )

        toolkit.register(discord_send_message)
        toolkit.register(discord_send_file)

    if wa_id and wa_token:
        base = f"https://api.green-api.com/waInstance{wa_id}"

        def chat_id(phone: str) -> str:
            return phone if "@" in phone else f"{phone}@c.us"

        async def whatsapp_send_message(phone: str, text: str) -> Any:
            """Send a text message through the configured WhatsApp account."""
            return await _json_post(
                f"{base}/sendMessage/{wa_token}",
                json={"chatId": chat_id(phone), "message": text},
            )

        async def whatsapp_send_file(phone: str, path: str | None = None,
                                     url: str | None = None,
                                     caption: str | None = None,
                                     filename: str | None = None) -> Any:
            """Send one local file or public URL through WhatsApp."""
            kind, source = _file_source(path, url)
            if kind == "url":
                name = filename or Path(urlparse(source).path).name or "file"
                return await _json_post(
                    f"{base}/sendFileByUrl/{wa_token}",
                    json={"chatId": chat_id(phone), "urlFile": source,
                          "fileName": name, "caption": caption or ""},
                )
            file_path = Path(source)
            name = filename or file_path.name
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            return await _json_post(
                f"{base}/sendFileByUpload/{wa_token}",
                data={"chatId": chat_id(phone), "fileName": name,
                      "caption": caption or ""},
                files={"file": (name, file_path.read_bytes(), mime)},
            )

        toolkit.register(whatsapp_send_message)
        toolkit.register(whatsapp_send_file)

    return toolkit

