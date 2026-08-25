"""Runtime configuration. Everything is environment-driven so the proxy can be
dropped onto any host (launchd / systemd / docker) without code edits.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


def _default_creds_file() -> Path:
    return Path(
        os.environ.get(
            "CLAUDE_SUB_PROXY_CREDS",
            str(Path.home() / ".claude-sub-proxy" / "credentials.json"),
        )
    )


def _parse_models() -> List[str]:
    raw = os.environ.get("CLAUDE_SUB_PROXY_MODELS")
    if raw:
        return [m.strip() for m in raw.split(",") if m.strip()]
    # Advertised on /v1/models. These are the ids OpenAgent will send back to
    # us as the request `model`; map them to real Anthropic ids via MODEL_MAP
    # if they ever diverge.
    return ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]


def _parse_model_map() -> Dict[str, str]:
    raw = os.environ.get("CLAUDE_SUB_PROXY_MODEL_MAP")
    if raw:
        try:
            return dict(json.loads(raw))
        except Exception:
            return {}
    return {}


@dataclass
class Settings:
    host: str = os.environ.get("CLAUDE_SUB_PROXY_HOST", "127.0.0.1")
    port: int = int(os.environ.get("CLAUDE_SUB_PROXY_PORT", "8787"))
    creds_file: Path = field(default_factory=_default_creds_file)

    # None => auto-select curl_cffi when importable, else httpx.
    transport: Optional[str] = os.environ.get("CLAUDE_SUB_PROXY_TRANSPORT") or None
    impersonate: str = os.environ.get("CLAUDE_SUB_PROXY_IMPERSONATE", "chrome")

    # Anthropic requires max_tokens; OpenAI callers often omit it.
    default_max_tokens: int = int(os.environ.get("CLAUDE_SUB_PROXY_MAX_TOKENS", "16384"))
    request_timeout: float = float(os.environ.get("CLAUDE_SUB_PROXY_TIMEOUT", "1800"))
    # Deprecated compatibility knob: older deployments used this as a streamed
    # chunk watchdog. Streaming is now intentionally pull-through with the HTTP
    # transport's request timeout, because a per-chunk thread watchdog can leak a
    # stuck worker and corrupt backpressure under long Claude thinking/tool gaps.
    chunk_timeout: float = float(
        os.environ.get(
            "CLAUDE_SUB_PROXY_CHUNK_TIMEOUT",
            os.environ.get("CLAUDE_SUB_PROXY_STREAM_CHUNK_TIMEOUT", "0"),
        )
    )

    # The subscription path 400s with >= 20 tools. Cap defensively. OpenAgent's
    # defer-all/tool-search setup usually sends far fewer, so this rarely bites.
    max_tools: int = int(os.environ.get("CLAUDE_SUB_PROXY_MAX_TOOLS", "19"))

    # NB: there is intentionally NO 1M-context toggle. 1M is native to Opus 4.8
    # on Max — a >200K request bills to the subscription at standard tier and
    # needs NO beta. Sending `context-1m` actually breaks that path, and Sonnet
    # 4.6 is usage-credit-gated on long context regardless. Long context simply
    # works when the registered model is claude-opus-4-8.

    # Optional bearer the proxy will require from callers (set the same value as
    # the OpenAgent provider's api_key). Unset => accept any/no key (localhost).
    api_key: Optional[str] = os.environ.get("CLAUDE_SUB_PROXY_API_KEY") or None

    # Subscription traffic is sensitive to bursts. Keep the defaults conservative
    # so a single Hermes instance cannot amplify retries into repeated 429s.
    upstream_max_concurrency: int = int(os.environ.get("CLAUDE_SUB_PROXY_UPSTREAM_MAX_CONCURRENCY", "1"))
    upstream_max_queue: int = int(os.environ.get("CLAUDE_SUB_PROXY_UPSTREAM_MAX_QUEUE", "32"))
    upstream_admission_timeout: float = float(os.environ.get("CLAUDE_SUB_PROXY_UPSTREAM_ADMISSION_TIMEOUT", "5"))
    upstream_queue_timeout: float = float(os.environ.get("CLAUDE_SUB_PROXY_UPSTREAM_QUEUE_TIMEOUT", "900"))
    upstream_min_interval: float = float(os.environ.get("CLAUDE_SUB_PROXY_UPSTREAM_MIN_INTERVAL", "4.0"))
    rate_limit_retries: int = int(os.environ.get("CLAUDE_SUB_PROXY_RATE_LIMIT_RETRIES", "2"))
    rate_limit_backoff: float = float(os.environ.get("CLAUDE_SUB_PROXY_RATE_LIMIT_BACKOFF", "20"))
    rate_limit_max_backoff: float = float(os.environ.get("CLAUDE_SUB_PROXY_RATE_LIMIT_MAX_BACKOFF", "180"))
    account_rate_limit_cooldown: float = float(
        os.environ.get("CLAUDE_SUB_PROXY_ACCOUNT_RATE_LIMIT_COOLDOWN", "360")
    )

    models: List[str] = field(default_factory=_parse_models)
    model_map: Dict[str, str] = field(default_factory=_parse_model_map)


settings = Settings()
