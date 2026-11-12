"""A model change must not relabel the canonical replies of earlier runs."""

import json
from types import SimpleNamespace

import pytest

from openagent_core.memory.db import MemoryDB
from openagent_dashboards.migration import ensure_custom_views_storage
from openagent_server.gateway.api.operational import handle_session_messages


@pytest.mark.asyncio
async def test_transcript_models_follow_exact_runs_after_session_model_changes(tmp_path):
    db = MemoryDB(str(tmp_path / "history.db"))
    await db.connect()
    try:
        conn = await db._ensure_connected()
        await ensure_custom_views_storage(conn, app_version="test")
        await db.upsert_session("chat", client_id="alice", title="Model history")
        runs = [{"run_id": suffix, "model": model, "status": "COMPLETED",
                 "created_at": 1_700_000_000 + i,
                 "messages": [{"id": "reply-" + suffix, "role": "assistant", "content": "Reply " + suffix}]}
                for i, (suffix, model) in enumerate((("a", "provider:model-a"), ("b", "provider:model-b")))]
        await conn.execute("UPDATE sessions SET runs=? WHERE session_id='chat'", (json.dumps(runs),))
        await db._project_operational_session("chat")
        await conn.execute("UPDATE sessions_v2 SET model='provider:current-selection' WHERE id='chat'")
        tenant = (await (await conn.execute("SELECT tenant_id FROM sessions_v2 WHERE id='chat'")).fetchone())[0]
        await conn.commit()

        class Request(dict):
            app = {"gateway": SimpleNamespace(agent=SimpleNamespace(memory_db=db), _operational_history_ready=True)}
            query = {"limit": "100"}
            match_info = {"session_id": "chat"}

        request = Request(auth_kind="device_cert", network_id=tenant, user_handle="alice", client_id="device",
                          device_cert=SimpleNamespace(network_id=tenant, handle="alice", device_pubkey_hex="device", capabilities=[]))
        response = await handle_session_messages(request)
        assert response.status == 200, response.text
        messages = json.loads(response.text)["messages"]
        assert [(message["text"], message["model"]) for message in messages] == [
            ("Reply a", "provider:model-a"), ("Reply b", "provider:model-b")]
    finally:
        await db.close()
