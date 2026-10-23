"""Official OpenAgent channels, independent of standalone services.

Provider SDK imports remain lazy; contracts can be used without an SDK or Core.
"""
from .contracts import (
    API_VERSION, DEFAULT_CONTEXT_MESSAGES, MAX_CONTEXT_BYTES, MAX_CONTEXT_MESSAGES, MAX_NEGOTIATED_CONTEXT_BYTES,
    BridgeAttachment, BridgeAttachmentNotice, BridgeCapabilities, BridgeCommand, BridgeCommandDefinition,
    BridgeCommandResult, BridgeContext, BridgeConversation, BridgeEvent, BridgeHistoryMessage,
    BridgeMessage, BridgePart, BridgePickerOption, BridgeReply, BridgeTransport,
)

__version__ = "0.1.0b12"


def __getattr__(name: str):
    providers = {"HostedSlackBridge": "hosted_slack", "SlackBridge": "slack", "DiscordBridge": "discord",
                 "TelegramBridge": "telegram", "WhatsAppBridge": "whatsapp",
                 "BaseBridge": "base"}
    if name not in providers:
        raise AttributeError(name)
    from importlib import import_module
    return getattr(import_module(f".{providers[name]}", __name__), name)

from .conversation import describe_conversation
