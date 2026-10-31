"""Chat command catalogue for bridges. Core owns it: see ``openagent_core.chat_commands``."""

from __future__ import annotations

from openagent_core.chat_commands import (BOT_COMMANDS, COMMAND_MAP, COMMAND_SPECS, COMMANDS,
                                          ChatCommandSpec as GatewayCommandSpec, command_help_text)

BRIDGE_COMMANDS = COMMANDS

__all__ = ["BOT_COMMANDS", "BRIDGE_COMMANDS", "COMMAND_MAP", "COMMAND_SPECS", "COMMANDS",
           "GatewayCommandSpec", "bridge_welcome_text", "command_help_text"]


def bridge_welcome_text(name: str | None = None) -> str:
    """Shared welcome text shown by chat bridges."""
    greeting = f"👋 Hi {name}! I'm your OpenAgent assistant." if name else "👋 Hi! I'm your OpenAgent assistant."
    return (
        f"{greeting}\n\n"
        "Send me a message, photo, voice note, or file and I'll help.\n\n"
        "Commands:\n"
        "/stop — cancel the current operation (keeps context)\n"
        "/clear — wipe everything and start a fresh conversation\n"
        "/new — same as /clear\n"
        "/status — agent status\n"
        "/help — all commands"
    )
