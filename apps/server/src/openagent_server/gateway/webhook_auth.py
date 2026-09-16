"""Compatibility exports; webhook verification is owned by the public core."""
from openagent_core.webhook_auth import WebhookAuthError, authenticate, extract_external_id

__all__ = ["WebhookAuthError", "authenticate", "extract_external_id"]
