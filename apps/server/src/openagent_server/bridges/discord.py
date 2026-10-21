"""Standalone compatibility adapter for the shared discord provider."""
from openagent_channel_bridges import discord as _provider
from .base import BaseBridge as StandaloneBaseBridge, make_gateway_transport

# Preserve legacy helper imports. Provider implementation remains shared.
for _key, _value in vars(_provider).items():
    if not _key.startswith("__") and _key not in {"DiscordBridge", "BaseBridge"}:
        globals()[_key] = _value


class DiscordBridge(_provider.DiscordBridge, StandaloneBaseBridge):
    def __init__(self, token: str, allowed_users=None, allowed_guilds=None,
                 listen_channels=None, dm_only=False,
                 gateway_url="ws://localhost:8765/ws", gateway_token=None,
                 personality=None, live=True, *, transport=None,
                 binding_id="discord", context_messages=20, members_intent=False):
        transport = transport if transport is not None else make_gateway_transport(
            gateway_url, gateway_token, name="discord", binding_id=binding_id)
        super().__init__(token, allowed_users, allowed_guilds, listen_channels, dm_only,
            personality=personality, live=live, transport=transport,
            binding_id=binding_id, context_messages=context_messages,
            members_intent=members_intent)
