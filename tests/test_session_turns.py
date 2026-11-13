"""The turn index lists human prompts only, bounded, paged and caller-relative."""

import json
from types import SimpleNamespace

import pytest

from openagent_core.memory.db import MemoryDB
from openagent_dashboards.migration import ensure_custom_views_storage
from openagent_server.gateway.api.operational import handle_session_turns


def _request(tenant: str, handle: str, query: dict[str, str]):
    class Request(dict):
        app = {"gateway": SimpleNamespace(agent=SimpleNamespace(memory_db=db_ref[0]), _operational_history_ready=True)}
        match_info = {"session_id": "chat"}

    request = Request(
        auth_kind="device_cert", network_id=tenant, user_handle=handle, client_id="device",
        device_cert=SimpleNamespace(network_id=tenant, handle=handle, device_pubkey_hex="device", capabilities=[]),
    )
    request.query = query
    return request


db_ref: list[MemoryDB] = []


@pytest.mark.asyncio
async def test_turn_index_lists_human_prompts_with_bounded_previews(tmp_path):
    db = MemoryDB(str(tmp_path / "history.db"))
    db_ref[:] = [db]
    await db.connect()
    try:
        conn = await db._ensure_connected()
        await ensure_custom_views_storage(conn, app_version="test")
        await db.upsert_session("chat", client_id="alice", title="Turns")
        long_prompt = "word " * 200
        prompts = [
            ("a", {"kind": "human", "handle": "alice"}, "First   question\nfrom alice"),
            ("b", {"kind": "human", "handle": "bob", "display": "Bob"}, "Bob joins in"),
            ("c", {"kind": "agent", "handle": "agent"}, "Scheduled self prompt"),
            ("d", {"kind": "human", "handle": "alice"}, long_prompt),
        ]
        runs = [
            {
                "run_id": suffix, "status": "COMPLETED", "created_at": 1_700_000_000 + index,
                "messages": [
                    {"id": "prompt-" + suffix, "role": "user", "content": text, "author": author},
                    {"id": "reply-" + suffix, "role": "assistant", "content": "Reply " + suffix},
                ],
            }
            for index, (suffix, author, text) in enumerate(prompts)
        ]
        await conn.execute("UPDATE sessions SET runs=? WHERE session_id='chat'", (json.dumps(runs),))
        await db._project_operational_session("chat")
        tenant = (await (await conn.execute("SELECT tenant_id FROM sessions_v2 WHERE id='chat'")).fetchone())[0]
        await conn.commit()

        response = await handle_session_turns(_request(tenant, "alice", {}))
        assert response.status == 200, response.text
        page = json.loads(response.text)
        turns = page["turns"]
        assert page["has_more"] is False
        # The agent's own seed prompt is not a human turn.
        assert [turn["message_id"] for turn in turns] == ["msg:chat:prompt-a", "msg:chat:prompt-b", "msg:chat:prompt-d"]
        assert [turn["own"] for turn in turns] == [True, False, True]
        assert turns[0]["preview"] == "First question from alice"
        assert turns[1]["author"]["display"] == "Bob"
        assert len(turns[2]["preview"]) == 240 and turns[2]["preview"].endswith("…")
        assert turns[0]["ordinal"] < turns[1]["ordinal"] < turns[2]["ordinal"]

        # A caller without access to the session learns nothing about it.
        assert (await handle_session_turns(_request(tenant, "mallory", {}))).status == 404

        # Forward paging from an ordinal returns only later turns.
        first = json.loads((await handle_session_turns(_request(tenant, "alice", {"limit": "1"}))).text)
        assert [turn["message_id"] for turn in first["turns"]] == ["msg:chat:prompt-a"] and first["has_more"] is True
        rest = json.loads((await handle_session_turns(_request(
            tenant, "alice", {"after_ordinal": str(first["turns"][0]["ordinal"]), "limit": "5"},
        ))).text)
        assert [turn["message_id"] for turn in rest["turns"]] == ["msg:chat:prompt-b", "msg:chat:prompt-d"]
        assert rest["has_more"] is False

        bad = await handle_session_turns(_request(tenant, "alice", {"limit": "0"}))
        assert bad.status == 400
    finally:
        await db.close()
