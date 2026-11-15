"""A history read waits for the worker to project fresh writes once history is prepared."""

import asyncio
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
