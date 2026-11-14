"""/api/cron/describe evaluates a schedule in the task's timezone and always
renders the upcoming fires with an explicit offset.

Regression: the preview used to evaluate the cron in UTC and print it as a
naive wall clock in the *server's* local zone, so a ``0 9 * * *`` task in
Asia/Dubai, served from a Europe/Rome host, previewed as ``10:00:00``
while the scheduler fired it at 09:00 Dubai.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import time
from zoneinfo import ZoneInfo

from aiohttp.test_utils import make_mocked_request

from openagent_server.gateway.api.workflow_tasks import handle_cron_describe


def _describe(query: str) -> tuple[int, dict]:
    request = make_mocked_request("GET", f"/api/cron/describe?{query}")
    response = asyncio.run(handle_cron_describe(request))
    return response.status, json.loads(response.body)


def _with_host_zone(name: str):
    previous = os.environ.get("TZ")
    os.environ["TZ"] = name
    time.tzset()
    return previous


def _restore_host_zone(previous):
    if previous is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = previous
    time.tzset()


def test_preview_uses_the_task_timezone_not_the_server_clock():
    previous = _with_host_zone("Europe/Rome")
    try:
        status, body = _describe("expression=0%209%20*%20*%20*&count=3&timezone=Asia/Dubai")
    finally:
        _restore_host_zone(previous)
    assert status == 200 and body["valid"] is True
    assert body["timezone"] == "Asia/Dubai"
    zone = ZoneInfo("Asia/Dubai")
    for entry in body["upcoming"]:
        assert entry["iso"].endswith("T09:00:00+04:00"), entry
        local = dt.datetime.fromtimestamp(entry["epoch"], zone)
        assert (local.hour, local.minute) == (9, 0)


def test_preview_without_timezone_is_explicit_utc():
    previous = _with_host_zone("Europe/Rome")
    try:
        status, body = _describe("expression=0%209%20*%20*%20*&count=2")
    finally:
        _restore_host_zone(previous)
    assert status == 200 and body["timezone"] == "UTC"
    for entry in body["upcoming"]:
        assert entry["iso"].endswith("T09:00:00+00:00"), entry


def test_preview_rejects_an_unknown_timezone():
    status, body = _describe("expression=0%209%20*%20*%20*&timezone=Mars/Olympus")
    assert status == 400 and body["valid"] is False
    assert "timezone" in body["error"].lower()
