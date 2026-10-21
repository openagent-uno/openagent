"""Standalone compatibility adapter for the shared whatsapp provider."""
from openagent_channel_bridges import whatsapp as _provider
from .base import BaseBridge as StandaloneBaseBridge, make_gateway_transport

# Preserve legacy helper imports. Provider implementation remains shared.
for _key, _value in vars(_provider).items():
    if not _key.startswith("__") and _key not in {"WhatsAppBridge", "BaseBridge"}:
        globals()[_key] = _value


class WhatsAppBridge(_provider.WhatsAppBridge, StandaloneBaseBridge):
    def __init__(self, instance_id: str, api_token: str, allowed_users=None,
                 gateway_url="ws://localhost:8765/ws", gateway_token=None,
                 personality=None, live=True, *, transport=None, binding_id="whatsapp"):
        transport = transport if transport is not None else make_gateway_transport(
            gateway_url, gateway_token, name="whatsapp", binding_id=binding_id)
        super().__init__(instance_id, api_token, allowed_users,
            personality=personality, live=live, transport=transport, binding_id=binding_id)
