"""The standalone gateway's side of the shared chat commands.

Semantics live in ``openagent_core.chat_commands``. This adapter only maps them
onto what the gateway alone can see: its stream registry, its RAM queue and its
session manager.
"""
from __future__ import annotations

from typing import Any

from openagent_core.chat_commands import ChatCommandHost, SessionRef, SessionStatus, StopOutcome


class GatewayCommandHost(ChatCommandHost):
    def __init__(self, gateway: Any, client_id: str, handle: str | None, *, request: Any = None) -> None:
        self.gateway = gateway
        self.client_id = client_id
        self.handle = handle
        # The verified request behind this connection, when the command came
        # from a signed-in client.
        self.request = request
        self.expose_errors = not client_id.startswith("bridge:")

    async def stop_session(self, session: SessionRef) -> StopOutcome:
        # ``_interrupt_stream_sessions`` cancels the LIVE StreamSession turn (the
        # real registry); ``stop_current`` is kept for the legacy/REST path.
        # Without the former a turn streaming into the session survives a wipe
        # and can interleave a stale reply into the fresh conversation.
        gateway, manager, client_id = self.gateway, self.gateway.sessions, self.client_id
        if session.session_id:
            streaming = await gateway._interrupt_stream_sessions(
                client_id, session.session_id, reason="manual", handle=self.handle,
            )
            stopped = manager.stop_current(client_id, session_id=session.session_id) or streaming
            return StopOutcome(stopped, manager.clear_queue_for_session(client_id, session.session_id))
        streaming = await gateway._interrupt_stream_sessions(client_id, reason="manual", handle=self.handle)
        stopped = manager.stop_current(client_id) or streaming
        return StopOutcome(stopped, manager.clear_queue(client_id))

    async def forget_history(self, session: SessionRef, agent: Any) -> int:
        if session.session_id:
            return await self.gateway._forget_one_session(session.session_id)
        return await self.gateway._forget_all_client_sessions(self.client_id)

    async def rotate_session(self, session: SessionRef) -> str:
        return self.gateway.sessions.create_session(self.client_id, handle=self.handle)

    async def session_status(self, session: SessionRef) -> SessionStatus:
        # Reflect the registry that actually runs turns (StreamSession), not the
        # always-idle SessionManager queue.
        gateway, manager, client_id = self.gateway, self.gateway.sessions, self.client_id
        busy = gateway._client_has_active_stream_turn(client_id, handle=self.handle) or manager.is_busy(client_id)
        return SessionStatus(busy, manager.queue_depth(client_id), len(manager.list_sessions(client_id)))


    async def goal_changed(self, session: SessionRef) -> None:
        # Renew or withdraw the delegation that lets this goal start again
        # after a runtime restart, as the person who just changed it.
        service = getattr(self.gateway, "runtime_service", None)
        if service is None or self.request is None or not session.session_id:
            return
        from openagent_server import goal_delegation

        context = await service.context(self.request, session.session_id)
        await goal_delegation.sync(service, session.session_id, context)
