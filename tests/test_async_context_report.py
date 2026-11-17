"""Context REST publication rechecks authorization after Core's worker yields."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import web
import pytest

from openagent_server.gateway.api import sessions


@pytest.mark.asyncio
async def test_report_revoked_during_worker_is_never_published():
    request = SimpleNamespace(app={"gateway": SimpleNamespace(agent=object())}, match_info={"session_id": "session"})
    denied = web.json_response({"error": "session not found"}, status=404)
    authorize = AsyncMock(side_effect=[(None, None, None, None), (None, None, None, denied)])
    with patch.object(sessions, "_db", return_value=object()), patch.object(sessions, "_authorized_session", authorize), patch(
        "openagent_core.core.context_report.build_context_report_async", AsyncMock(return_value={"session_id": "session", "private": "report"}),
    ):
        response = await sessions.handle_get_context(request)
    assert response.status == 404
    assert "private" not in response.text
    assert authorize.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("report", [None, {"session_id": "session", "context_window": 200000, "turns": 20}])
async def test_context_report_and_empty_fallback_keep_their_wire_shape(report):
    request = SimpleNamespace(app={"gateway": SimpleNamespace(agent=object())}, match_info={"session_id": "session"})
    authorize = AsyncMock(return_value=(None, None, None, None))
    with patch.object(sessions, "_db", return_value=object()), patch.object(sessions, "_authorized_session", authorize), patch(
        "openagent_core.core.context_report.build_context_report_async", AsyncMock(return_value=report),
    ):
        response = await sessions.handle_get_context(request)
    expected = report or {"session_id": "session", "sections": [], "context_window": 0}
    assert json.loads(response.text) == expected
    assert authorize.await_count == 2


@pytest.mark.asyncio
async def test_context_worker_errors_keep_the_existing_error_response():
    request = SimpleNamespace(app={"gateway": SimpleNamespace(agent=object())}, match_info={"session_id": "session"})
    with patch.object(sessions, "_db", return_value=object()), patch.object(
        sessions, "_authorized_session", AsyncMock(return_value=(None, None, None, None)),
    ), patch("openagent_core.core.context_report.build_context_report_async", AsyncMock(side_effect=ValueError("controlled report failure"))):
        response = await sessions.handle_get_context(request)
    assert response.status == 500
    assert json.loads(response.text) == {"error": "controlled report failure"}
