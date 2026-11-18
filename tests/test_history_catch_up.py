"""A history read waits for the worker to project fresh writes once history is prepared."""

import asyncio
import json
import time
from types import SimpleNamespace

import pytest

from openagent_core.memory.db import MemoryDB
from openagent_server.gateway.api import operational
from openagent_server.gateway.api.operational import ApiProblem


@pytest.fixture
async def db(tmp_path):
    database = MemoryDB(str(tmp_path / "history.db"))
    await database.connect()
    yield database
    await database.close()


def request_for(gateway):
    class Request(dict):
        app = {"gateway": gateway}

    return Request()


def gateway_for(db, *, prepared):
    event = asyncio.Event()
    if prepared:
        event.set()
    return SimpleNamespace(agent=SimpleNamespace(memory_db=db), _operational_history_ready=False,
                           _operational_ready_event=event)


@pytest.fixture(autouse=True)
def no_worker(monkeypatch):
    monkeypatch.setattr(operational, "_start_background", lambda request, db: None)


@pytest.mark.asyncio
async def test_a_read_right_after_a_write_waits_for_the_worker(db):
    gateway = gateway_for(db, prepared=True)

    async def worker_catches_up():
        await asyncio.sleep(0.3)
        gateway._operational_history_ready = True

    catch_up = asyncio.create_task(worker_catches_up())
    _, conn = await operational._canonical_conn(request_for(gateway))
    await catch_up

    assert conn is not None


@pytest.mark.asyncio
async def test_history_that_was_never_prepared_answers_warming_at_once(db):
    gateway = gateway_for(db, prepared=False)

    started = time.monotonic()
    with pytest.raises(ApiProblem) as problem:
        await operational._canonical_conn(request_for(gateway))

    assert problem.value.status == 503
    assert time.monotonic() - started < 0.5


@pytest.mark.asyncio
async def test_the_wait_is_bounded(db, monkeypatch):
    monkeypatch.setattr(operational, "_CATCH_UP_WAIT_S", 0.3)
    gateway = gateway_for(db, prepared=True)

    started = time.monotonic()
    with pytest.raises(ApiProblem) as problem:
        await operational._canonical_conn(request_for(gateway))

    assert problem.value.status == 503
    assert time.monotonic() - started < 1.5


@pytest.mark.asyncio
async def test_background_history_becomes_ready_with_a_nullable_runtime_mirror(db):
    from openagent_dashboards.migration import ensure_custom_views_storage

    await db.upsert_session("nullable-mirror", client_id="alice", title="Preserved title")
    conn = await db._ensure_connected()
    await ensure_custom_views_storage(conn, app_version="test")
    await conn.execute("UPDATE sessions_v2 SET metadata_json=json_set(metadata_json,'$.runtime_contract',1) "
                       "WHERE id='nullable-mirror'")
    await conn.execute("UPDATE sessions SET metadata='null' WHERE session_id='nullable-mirror'")
    await conn.commit()
    gateway = gateway_for(db, prepared=False)
    worker = asyncio.create_task(operational._background_bootstrap(gateway, db))
    try:
        await asyncio.wait_for(gateway._operational_ready_event.wait(), 5)
        assert gateway._operational_history_ready is True
        assert gateway._operational_bootstrap_error is False
        assert (await (await conn.execute(
            "SELECT count(*) FROM legacy_session_changes WHERE processed_at_ms IS NULL"
        )).fetchone())[0] == 0
        row = await (await conn.execute(
            "SELECT title,metadata_json FROM sessions_v2 WHERE id='nullable-mirror'"
        )).fetchone()
        assert row[0] == "Preserved title" and json.loads(row[1])["runtime_contract"] == 1
    finally:
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker
