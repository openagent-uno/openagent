"""claude-sub-proxy — an OpenAI-compatible front for a Claude subscription.

A standalone localhost service that accepts OpenAI ``/v1/chat/completions``
requests and re-originates each one as a Claude-Code-faithful Anthropic
``/v1/messages`` call, so inference is billed against a Claude Pro/Max
subscription instead of a metered API key. It carries no OpenAgent (or Hermes)
imports — OpenAgent talks to it purely as a ``local`` model via ``base_url``.

The TLS/header impersonation and OAuth-refresh logic are lifted from
``marf/hermes-agent-claude-sub`` (``agent/cc_anthropic.py`` and the
``_is_oauth_token`` / ``refresh_anthropic_oauth_pure`` branches of
``agent/anthropic_adapter.py``).
"""

__version__ = "0.1.0"
