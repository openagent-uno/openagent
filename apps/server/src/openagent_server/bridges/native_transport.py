"""Standalone channels use the installation's normal runtime and network users.

The operator explicitly maps provider accounts/users. No bridge certificate is
promoted to the installation owner, and provider membership is never a grant.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
import time

from openagent_core.artifacts import ArtifactRepository
from openagent_core.contracts import ExecutionContext, PrincipalRef, ResourceRef, RunRequest
from openagent_channel_bridges.contracts import (
    BridgeAttachment, BridgeCapabilities, BridgeCommandResult, BridgeEvent, BridgePart, BridgeReply,
)
from openagent_channel_bridges.history import render_history
from openagent_channel_bridges.media import authorized_file_chunks, media_file_snapshot
from .terminal import terminal_answer


class _Artifacts:
    def __init__(self, host, provider_context):
        self.host, self.provider_context = host, provider_context

    async def authorize(self, context, action, resource, *, audience=()):
        expected = await self.host._execution(self.provider_context, register=False)
        if (context != expected or tuple(audience) != context.audience
                or resource.tenant_id != context.tenant_id):
            return False
        if resource.kind == "agent":
            return resource.resource_id == context.agent_id and action in {"artifact.read", "artifact.write"}
        if resource.kind == "session":
            return resource.resource_id == context.session_id and action in {"artifact.read", "artifact.write"}
        # Never treat a guessed owner/private CAS path as delivery authority.
        return False


class NativeChannelTransport:
    legacy_markers = False

    def __init__(self, service, provider, binding_id):
        self.service, self.name, self.binding_id = service, provider, binding_id
        self.bridge = None
        self.enabled = True
        self._delivery_files = {}

    def bind_bridge(self, bridge):
        self.bridge = bridge

    def _identity(self, context):
        channel = (self.service.agent.config.get("channels") or {}).get(self.name) or {}
        identity = channel.get("identity") or {}
        mappings = identity.get("user_bindings") if isinstance(identity, dict) else None
        if (not self.enabled or channel.get("enabled", True) is not True
                or not isinstance(identity, dict) or not isinstance(mappings, dict)
                or not 1 <= len(mappings) <= 1000
                or set(identity) != {"tenant_id", "account_id", "user_bindings"}
                or context.provider != self.name or context.binding_id != self.binding_id
                or context.account_id != identity.get("account_id")
                or not identity.get("tenant_id") or context.actor_id not in mappings
                or any(not isinstance(k, str) or not k or not isinstance(v, str) or not v
                       or len(k.encode()) > 512 or len(v.encode()) > 512 for k, v in mappings.items())
                or len(set(mappings.values())) != len(mappings)):
            raise PermissionError("Channel identity mapping is unavailable")
        return identity, mappings

    async def authorize_context(self, context):
        try:
            identity, mappings = self._identity(context)
            directory = await self.service.directory.snapshot(identity["tenant_id"])
            return mappings[context.actor_id] in directory["users"]
        except (PermissionError, KeyError):
            return False

    async def _resolved(self, context, *, require_fresh=True):
        identity, mappings = self._identity(context)
        descriptor = context.conversation
        if (descriptor is None or context.audience_verified_at is None
                or require_fresh and not 0 <= time.time() - context.audience_verified_at <= 30):
            raise PermissionError("A fresh complete channel audience is required")
        directory = await self.service.directory.snapshot(identity["tenant_id"])
        if any(actor not in mappings or mappings[actor] not in directory["users"]
               for actor in descriptor.audience_ids):
            raise PermissionError("Every recipient needs a current network-user mapping")
        pairs = [(external, mappings[external]) for external in descriptor.audience_ids]
        material = json.dumps((identity["tenant_id"], descriptor.session_key, pairs),
                              ensure_ascii=False, separators=(",", ":")).encode()
        session_id = "channel-shared-v1-" + hashlib.sha256(material).hexdigest()
        principal = PrincipalRef("openagent", identity["tenant_id"], mappings[context.actor_id])
        audience = tuple(PrincipalRef("openagent", identity["tenant_id"], user) for _, user in pairs)
        return ExecutionContext(principal, principal, principal, session_id,
                                self.service.agent.name, audience)

    async def _fresh(self, original, expected):
        if self.bridge is None or self.bridge._should_stop or not await self.authorize_context(original):
            return False
        latest = await self.bridge._delivery_context(original)
        if (not self.bridge._same_delivery_identity(original, latest)
                or latest.conversation != original.conversation):
            return False
        try:
            return await self._resolved(latest) == expected
        except PermissionError:
            return False

    async def _execution(self, context, *, register=True):
        resolved = await self._resolved(context, require_fresh=False)
        if not await self._fresh(context, resolved):
            raise PermissionError("Channel authorization changed")
        if not register:
            return resolved
        async def descendant(child):
            parent_id, seen = child.parent_run_id, set()
            while parent_id is not None and len(seen) < 32 and parent_id not in seen:
                seen.add(parent_id)
                try:
                    parent = await self.service.runtime.services.store.accepted_request(parent_id)
                except LookupError:
                    return False
                if (parent.authority != resolved.authority or parent.initiator != resolved.initiator
                        or parent.audience != resolved.audience):
                    return False
                if parent.request.session_id == resolved.session_id:
                    return True
                parent_id = parent.parent_run_id
            return False
        return self.service.authorizer.bind_channel(resolved, lambda: self._fresh(context, resolved),
                                                    validate_child=descendant)

    async def authorize_delivery(self, context):
        try:
            await self._execution(context, register=False)
            return True
        except PermissionError:
            return False

    async def start(self):
        self.enabled = True
        return BridgeCapabilities(input_media=("file", "image", "audio", "voice", "video"),
                                  output_media=("file", "image", "audio", "voice", "video"),
                                  progress_kinds=("status", "text"), history_media=True, history_max_files=64)

    async def stop(self):
        self.enabled = False
        # Only files created by this transport are removed; the agent/runtime
        # and canonical artifacts belong to the installation, not the channel.
        for path, identity in tuple(self._delivery_files.items()):
            try:
                metadata = path.lstat()
                if not path.is_symlink() and (metadata.st_dev, metadata.st_ino) == identity:
                    path.unlink()
            except FileNotFoundError:
                pass
        self._delivery_files.clear()

    async def send(self, request, *, on_event=None):
        context = await self._execution(request.context)
        canonical = replace(context, ingress_id=None)
        run_id = "channel-" + hashlib.sha256(json.dumps(request.context.deduplication_key).encode()).hexdigest()
        # Provider history is freshly fetched and can change on redelivery.
        # Compare only the event's immutable payload; reuse its durable input.
        payload = [{"text": part.text} if part.text is not None else {
            "kind": part.attachment.kind, "filename": part.attachment.filename,
            "mime_type": part.attachment.mime_type, "size_bytes": part.attachment.size_bytes,
            "provider_attachment_id": part.attachment.provider_attachment_id,
            "sha256": part.attachment.sha256} for part in request.parts]
        input_digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        try:
            accepted = await self.service.runtime.accepted_request(run_id, context)
        except LookupError:
            accepted = None
        if accepted is not None and (accepted.author != context.author
                or accepted.request.session_id != context.session_id
                or accepted.request.idempotency_key != input_digest):
            from openagent_core.contracts import IdempotencyConflict
            raise IdempotencyConflict("Channel event belongs to a different payload or actor")
        artifacts = ArtifactRepository(self.service.agent.memory_db, _Artifacts(self, request.context),
                                       max_input_bytes=32 << 20, max_output_bytes=32 << 20)
        attachments = []
        input_parts = request.parts + tuple(part for record in request.history for part in record.parts
                                            if part.attachment is not None)
        media_parts = [part for part in input_parts if part.attachment is not None]
        if (sum(part.attachment is not None for part in request.parts) > 16
                or len(media_parts) > (64 if request.history else 16)
                or sum(part.attachment.size_bytes for part in media_parts) > 64 << 20):
            raise ValueError("Channel input media limit reached")
        for part in (() if accepted is not None else input_parts):
            attachment = part.attachment
            if attachment is None:
                continue
            if not attachment.local_path:
                raise ValueError("Provider media needs its authorized staged reader")
            snapshot = media_file_snapshot(attachment.local_path, limit=32 << 20)
            chunks = []
            async def authorize():
                if not await self._fresh(request.context, canonical):
                    raise PermissionError("Channel media authorization changed")
            async for chunk in authorized_file_chunks(attachment.local_path, authorize,
                                                      snapshot=snapshot, limit=32 << 20):
                chunks.append(chunk)
            content = b"".join(chunks)
            if (len(content) != attachment.size_bytes
                    or attachment.sha256 and hashlib.sha256(content).hexdigest() != attachment.sha256):
                raise ValueError("Provider media integrity changed")
            attachments.append(await artifacts.upload(canonical, content, filename=attachment.filename,
                mime_type=attachment.mime_type, session_id=context.session_id))
        text = "\n".join(part.text for part in request.parts if part.text is not None)
        history = render_history(request.history)
        if history:
            text = history + "\n\nCurrent message:\n" + text
        submitted = accepted.request if accepted is not None else RunRequest(
            run_id, context.session_id, input_digest, text, attachments=tuple(attachments))
        await self.service.runtime.submit(submitted, context)
        cursor, final = 0, None
        while True:
            for event in await self.service.runtime.events(run_id, cursor, context):
                cursor = event.cursor
                if event.kind == "run.stream":
                    value = event.payload
                    if value.get("kind") == "done":
                        final = value
                    elif value.get("kind") == "delta" and on_event is not None:
                        await on_event(BridgeEvent("text", value.get("text") or ""))
                elif event.kind == "run.status" and on_event is not None:
                    await on_event(BridgeEvent("status", str(event.payload.get("text") or "")))
            record = await self.service.runtime.get_run(run_id, context)
            if record.terminal:
                break
            await asyncio.sleep(0.025)
        if record.status != "success":
            return BridgeReply(status="failed", session_ref=context.session_id, run_ref=run_id)
        if not await self._fresh(request.context, canonical):
            raise PermissionError("Channel result audience changed")
        answer = terminal_answer(final or {},
            require_attested=getattr(self.bridge, "_delivery_mode", "quiet") == "quiet")
        source_parts = answer.get("parts")
        if source_parts is None:
            source_parts = [{"kind": "text", "text": answer.get("text", "") or ""}]
            source_parts += [{"kind": "attachment", "attachment": value}
                             for value in answer.get("attachments") or ()]
        parts = []
        for part in source_parts:
            if part.get("kind") == "text":
                parts.append(BridgePart(text=part["text"]))
                continue
            if part.get("kind") != "attachment":
                raise ValueError("Unsupported canonical channel result part")
            value = part["attachment"]
            identifier = value.get("artifact_id")
            if not identifier:
                raise ValueError("Agent media needs a canonical authorized artifact")
            content = await artifacts.read(canonical, artifact_id=identifier)
            for old in tuple(self._delivery_files):
                if not old.exists():
                    self._delivery_files.pop(old)
            if len(content.content) > 32 << 20 or len(self._delivery_files) >= 64:
                raise ValueError("Channel delivery media limit reached")
            with tempfile.NamedTemporaryFile(prefix="oa-channel-", delete=False) as file:
                file.write(content.content)
                info = Path(file.name).stat()
            path = Path(file.name)
            self._delivery_files[path] = (info.st_dev, info.st_ino)
            kind = "image" if content.mime_type.startswith("image/") else "video" if content.mime_type.startswith("video/") else "audio" if content.mime_type.startswith("audio/") else "file"
            parts.append(BridgePart(attachment=BridgeAttachment(kind, content.filename, content.mime_type,
                len(content.content), artifact_ref=identifier, local_path=str(path), owned=True,
                sha256=content.sha256)))
        return BridgeReply(tuple(parts), session_ref=context.session_id, run_ref=run_id)

    async def command(self, request):
        # Never run a gateway command as the bridge certificate/owner alias.
        if not await self.authorize_delivery(request.context):
            raise PermissionError("Channel command is not authorized")
        return BridgeCommandResult(status="failed", parts=(BridgePart(text="Use the agent conversation or authenticated App for this command."),))

    async def transcribe(self, context, attachment):
        expected = await self._execution(context, register=False)
        if attachment.local_path is None or attachment.kind not in {"audio", "voice"}:
            raise ValueError("Channel transcription needs staged audio")
        snapshot = media_file_snapshot(attachment.local_path, limit=16 << 20)
        async def authorize():
            if not await self._fresh(context, expected):
                raise PermissionError("Channel transcription authorization changed")
        with tempfile.TemporaryDirectory(prefix="oa-channel-audio-") as directory:
            target = Path(directory) / attachment.filename
            digest = hashlib.sha256()
            with target.open("xb") as output:
                async for chunk in authorized_file_chunks(attachment.local_path, authorize,
                                                          snapshot=snapshot, limit=16 << 20):
                    output.write(chunk)
                    digest.update(chunk)
            if (snapshot[2] != attachment.size_bytes
                    or attachment.sha256 and digest.hexdigest() != attachment.sha256):
                raise ValueError("Channel audio integrity changed")
            result = await self._voice().transcribe(target)
            await authorize()
            return result

    def _voice(self):
        from openagent_server.audio_service import service_for_runtime
        return service_for_runtime(self.service)

    async def synthesize(self, context, text):
        if not await self.authorize_delivery(context):
            raise PermissionError("Channel speech is not authorized")
        result = await self._voice().synthesize(text)
        if not await self.authorize_delivery(context):
            raise PermissionError("Channel speech authorization changed")
        if result is None:
            return None
        if len(result.data) > 16 << 20:
            raise ValueError("Channel speech exceeds delivery limit")
        with tempfile.NamedTemporaryFile(prefix="oa-channel-", delete=False) as file:
            file.write(result.data)
            info = Path(file.name).stat()
        path = Path(file.name)
        self._delivery_files[path] = (info.st_dev, info.st_ino)
        suffix = {"audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
                  "audio/webm": ".webm"}.get(result.media_type, ".audio")
        return BridgeAttachment("voice", "speech" + suffix, result.media_type, len(result.data),
            local_path=str(path), owned=True, sha256=hashlib.sha256(result.data).hexdigest())
