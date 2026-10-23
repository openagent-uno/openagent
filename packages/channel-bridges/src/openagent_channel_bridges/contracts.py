"""Version 1 public contracts for channels using a host's existing agent.

Provider identifiers are routing data, never authenticated host principals or
grants. Hosts resolve and reauthorize every call through their normal services.
This module deliberately depends only on the Python standard library.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Literal, Protocol, runtime_checkable

API_VERSION = 1
DEFAULT_CONTEXT_MESSAGES = 20
MAX_CONTEXT_MESSAGES = 200
MAX_CONTEXT_BYTES = 65_536
MAX_NEGOTIATED_CONTEXT_BYTES = 262_144


def _version(value: int) -> None:
    if type(value) is not int or value != API_VERSION:
        raise ValueError("unsupported channel contract version")


def _identifier(value: str, name: str, *, optional: bool = False) -> None:
    if optional and value is None:
        return
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 512:
        raise ValueError(f"{name} must be a nonempty identifier of at most 512 bytes")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise ValueError(f"{name} contains control characters")


@dataclass(frozen=True, slots=True)
class BridgeConversation:
    """Stable routing descriptor; provider audience evidence is not a host grant."""
    mode: Literal["private", "channel", "thread"]
    binding_id: str
    provider: str
    account_id: str
    conversation_id: str
    thread_id: str | None
    private_actor_id: str | None
    audience_ids: tuple[str, ...]
    audience_epoch: str
    session_key: str
    api_version: int = API_VERSION

    def __post_init__(self) -> None:
        import re
        _version(self.api_version)
        if self.mode not in ("private", "channel", "thread"):
            raise ValueError("unknown conversation mode")
        for name in ("binding_id", "provider", "account_id", "conversation_id"):
            _identifier(getattr(self, name), name)
        for name in ("thread_id", "private_actor_id"):
            _identifier(getattr(self, name), name, optional=True)
        object.__setattr__(self, "audience_ids", tuple(self.audience_ids))
        if (not 1 <= len(self.audience_ids) <= 1000
                or len(set(self.audience_ids)) != len(self.audience_ids)):
            raise ValueError("invalid conversation audience")
        for actor in self.audience_ids:
            _identifier(actor, "conversation audience actor")
        if self.audience_ids != tuple(sorted(self.audience_ids, key=lambda value: value.encode("utf-8"))):
            raise ValueError("conversation audience must be in UTF-8 byte order")
        if (self.mode == "private" and self.audience_ids != (self.private_actor_id,)
                or self.mode != "private" and self.private_actor_id is not None
                or self.mode == "channel" and self.thread_id is not None
                or self.mode == "thread" and self.thread_id is None
                or not re.fullmatch("[a-f0-9]{64}", self.audience_epoch)
                or not re.fullmatch("oa-channel-v1-[a-f0-9]{64}", self.session_key)):
            raise ValueError("invalid conversation routing descriptor")


@dataclass(frozen=True, slots=True)
class BridgeContext:
    binding_id: str
    provider: str
    account_id: str
    actor_id: str
    conversation_id: str
    event_id: str
    thread_id: str | None = None
    reply_to_event_id: str | None = None
    api_version: int = API_VERSION
    conversation_kind: Literal["unknown", "direct", "group", "channel", "thread"] = "unknown"
    audience_ids: tuple[str, ...] = ()
    audience_complete: bool = False
    audience_verified_at: float | None = None

    def __post_init__(self) -> None:
        _version(self.api_version)
        for name in ("binding_id", "provider", "account_id", "actor_id", "conversation_id", "event_id"):
            _identifier(getattr(self, name), name)
        for name in ("thread_id", "reply_to_event_id"):
            _identifier(getattr(self, name), name, optional=True)
        if self.conversation_kind not in ("unknown", "direct", "group", "channel", "thread"):
            raise ValueError("unknown conversation kind")
        if not isinstance(self.audience_ids, (tuple, list)) or len(self.audience_ids) > 1000:
            raise ValueError("audience must contain at most 1000 provider IDs")
        object.__setattr__(self, "audience_ids", tuple(self.audience_ids))
        for actor in self.audience_ids:
            _identifier(actor, "audience actor")
        if len(set(self.audience_ids)) != len(self.audience_ids):
            raise ValueError("audience must contain distinct provider IDs")
        if type(self.audience_complete) is not bool:
            raise ValueError("audience completeness must be a boolean")
        if self.audience_verified_at is not None:
            import math
            if (type(self.audience_verified_at) not in (int, float)
                    or not math.isfinite(self.audience_verified_at) or self.audience_verified_at < 0):
                raise ValueError("audience verification time is invalid")

    @property
    def conversation(self) -> BridgeConversation | None:
        from .conversation import describe_conversation
        return describe_conversation(self)

    @property
    def deduplication_key(self) -> tuple[str, str, str, str]:
        return self.binding_id, self.provider, self.account_id, self.event_id


@dataclass(frozen=True, slots=True)
class BridgeAttachment:
    kind: str
    filename: str
    mime_type: str = "application/octet-stream"
    size_bytes: int = 0
    artifact_ref: str = ""
    local_path: str | None = None
    owned: bool = False
    provider_attachment_id: str | None = None
    sha256: str | None = None
    reader_ref: str | None = None

    def __post_init__(self) -> None:
        if type(self.size_bytes) is not int or self.size_bytes < 0:
            raise ValueError("size_bytes must be nonnegative")
        if not self.filename or "/" in self.filename or "\\" in self.filename or self.filename in (".", ".."):
            raise ValueError("filename must be a safe basename")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in self.filename):
            raise ValueError("filename contains control characters")
        if self.provider_attachment_id is not None:
            _identifier(self.provider_attachment_id, "provider_attachment_id")
        if self.sha256 is not None:
            import re
            if not re.fullmatch(r"[0-9a-f]{64}", self.sha256):
                raise ValueError("sha256 must be a lowercase SHA-256 hex digest")
        if self.reader_ref is not None:
            _identifier(self.reader_ref, "reader_ref")


@dataclass(frozen=True, slots=True)
class BridgePart:
    text: str | None = None
    attachment: BridgeAttachment | None = None

    def __post_init__(self) -> None:
        if (self.text is None) == (self.attachment is None):
            raise ValueError("a part contains exactly one text or attachment")


@dataclass(frozen=True, slots=True)
class BridgeAttachmentNotice:
    """Safe metadata for history media that was not made available to the host."""
    kind: str
    filename: str
    mime_type: str = "application/octet-stream"
    size_bytes: int = 0
    provider_attachment_id: str | None = None
    reason: Literal["unsupported", "limit", "unavailable", "blocked"] = "unavailable"

    def __post_init__(self) -> None:
        BridgeAttachment(self.kind, self.filename, self.mime_type, self.size_bytes,
                         provider_attachment_id=self.provider_attachment_id)
        if self.reason not in ("unsupported", "limit", "unavailable", "blocked"):
            raise ValueError("unknown history media omission reason")


@dataclass(frozen=True, slots=True)
class BridgeHistoryMessage:
    event_id: str
    actor_id: str
    parts: tuple[BridgePart, ...]
    timestamp: str | None = None
    omitted_attachments: tuple[BridgeAttachmentNotice, ...] = ()

    def __post_init__(self) -> None:
        _identifier(self.event_id, "event_id")
        _identifier(self.actor_id, "actor_id")
        object.__setattr__(self, "parts", tuple(self.parts))
        object.__setattr__(self, "omitted_attachments", tuple(self.omitted_attachments))
        if len(self.omitted_attachments) > 16 or any(not isinstance(item, BridgeAttachmentNotice) for item in self.omitted_attachments):
            raise ValueError("invalid history media omissions")


@dataclass(frozen=True, slots=True)
class BridgeMessage:
    context: BridgeContext
    parts: tuple[BridgePart, ...]
    history: tuple[BridgeHistoryMessage, ...] = ()
    source: str = "text"
    presentation: str | None = None
    api_version: int = API_VERSION
    conversation: BridgeConversation | None = field(init=False)

    def __post_init__(self) -> None:
        _version(self.api_version)
        object.__setattr__(self, "conversation", self.context.conversation)
        object.__setattr__(self, "parts", tuple(self.parts))
        object.__setattr__(self, "history", tuple(self.history))
        if len(self.history) > MAX_CONTEXT_MESSAGES:
            raise ValueError("channel history exceeds 200 messages")
        if len(self.parts) + sum(len(item.parts) + len(item.omitted_attachments) for item in self.history) > 256:
            raise ValueError("channel input exceeds 256 parts")
        # Include attribution and escaping overhead, not only text characters.
        from .history import history_size_bytes
        if history_size_bytes(self.history) > MAX_NEGOTIATED_CONTEXT_BYTES:
            raise ValueError("channel history exceeds 256 KiB")


@dataclass(frozen=True, slots=True)
class BridgeCommandDefinition:
    name: str
    description: str
    confirmation_required: bool = False


@dataclass(frozen=True, slots=True)
class BridgeCapabilities:
    commands: tuple[BridgeCommandDefinition, ...] = ()
    input_media: tuple[str, ...] = ()
    output_media: tuple[str, ...] = ()
    progress_kinds: tuple[str, ...] = ()
    api_version: int = API_VERSION
    history_media: bool = False
    history_max_files: int = 16
    history_max_bytes: int = MAX_CONTEXT_BYTES

    def __post_init__(self) -> None:
        _version(self.api_version)
        if type(self.history_max_bytes) is not int or not MAX_CONTEXT_BYTES <= self.history_max_bytes <= MAX_NEGOTIATED_CONTEXT_BYTES:
            raise ValueError("history_max_bytes must be an integer between 65536 and 262144")
        if type(self.history_media) is not bool:
            raise ValueError("history_media must be a boolean")
        if (type(self.history_max_files) is not int or not 16 <= self.history_max_files <= 64
                or not self.history_media and self.history_max_files != 16):
            raise ValueError("history_max_files requires history media and a bound between 16 and 64")
        for name in ("commands", "input_media", "output_media", "progress_kinds"):
            object.__setattr__(self, name, tuple(getattr(self, name)))


@dataclass(frozen=True, slots=True)
class BridgeEvent:
    kind: str
    text: str = ""
    run_ref: str | None = None
    api_version: int = API_VERSION

    def __post_init__(self) -> None:
        _version(self.api_version)


@dataclass(frozen=True, slots=True)
class BridgeReply:
    parts: tuple[BridgePart, ...] = ()
    status: Literal["completed", "coalesced", "cancelled", "failed"] = "completed"
    model: str | None = None
    session_ref: str | None = None
    run_ref: str | None = None
    api_version: int = API_VERSION

    def __post_init__(self) -> None:
        _version(self.api_version)
        object.__setattr__(self, "parts", tuple(self.parts))
        if self.status not in ("completed", "coalesced", "cancelled", "failed"):
            raise ValueError("unknown reply status")


@dataclass(frozen=True, slots=True)
class BridgeCommand:
    context: BridgeContext
    name: str
    argument: str | None = None
    confirmed: bool = False
    api_version: int = API_VERSION
    conversation: BridgeConversation | None = field(init=False)

    def __post_init__(self) -> None:
        _version(self.api_version)
        object.__setattr__(self, "conversation", self.context.conversation)
        _identifier(self.name, "command name")


@dataclass(frozen=True, slots=True)
class BridgePickerOption:
    value: str
    label: str
    subtitle: str | None = None
    active: bool = False


@dataclass(frozen=True, slots=True)
class BridgeCommandResult:
    status: str = "completed"
    parts: tuple[BridgePart, ...] = ()
    options: tuple[BridgePickerOption, ...] = ()
    picker_command: str | None = None
    picker_prompt: str | None = None
    api_version: int = API_VERSION

    def __post_init__(self) -> None:
        _version(self.api_version)
        object.__setattr__(self, "parts", tuple(self.parts))
        object.__setattr__(self, "options", tuple(self.options))


@runtime_checkable
class BridgeTransport(Protocol):
    async def start(self) -> BridgeCapabilities: ...
    async def stop(self) -> None: ...
    async def authorize_context(self, context: BridgeContext) -> bool:
        """Revalidate current actor and binding before input/provider IO."""
        ...
    async def authorize_delivery(self, context: BridgeContext) -> bool:
        """Authorize all freshly verified result recipients; required for groups.

        Older direct-message transports may omit this additive method and use
        authorize_context. Missing group authorization always denies delivery.
        """
        ...
    async def send(self, request: BridgeMessage, *,
                   on_event: Callable[[BridgeEvent], Awaitable[None]] | None = None) -> BridgeReply: ...
    async def command(self, request: BridgeCommand) -> BridgeCommandResult: ...
    async def transcribe(self, context: BridgeContext, attachment: BridgeAttachment) -> str | None: ...
    async def synthesize(self, context: BridgeContext, text: str) -> BridgeAttachment | None: ...
