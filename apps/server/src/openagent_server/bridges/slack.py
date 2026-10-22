"""Standalone compatibility adapter for the shared slack provider."""
from openagent_channel_bridges import slack as _provider
from .base import BaseBridge as StandaloneBaseBridge, make_gateway_transport

# Preserve legacy helper imports. Provider implementation remains shared.
for _key, _value in vars(_provider).items():
    if not _key.startswith("__") and _key not in {"SlackBridge", "BaseBridge"}:
        globals()[_key] = _value


class SlackBridge(_provider.SlackBridge, StandaloneBaseBridge):
    def __init__(self, bot_token: str, app_token: str | None = None,
                 allowed_users=None, listen_channels=None,
                 gateway_url="ws://localhost:8765/ws", gateway_token=None,
                 personality=None, live=None, *, transport=None,
                 binding_id="slack", context_messages=20, delivery_mode=None, acknowledgement_text=None):
        transport = transport if transport is not None else make_gateway_transport(
            gateway_url, gateway_token, name="slack", binding_id=binding_id)
        super().__init__(bot_token, app_token, allowed_users, listen_channels,
            personality=personality, live=live, transport=transport,
            binding_id=binding_id, context_messages=context_messages, delivery_mode=delivery_mode,
            acknowledgement_text=acknowledgement_text)
