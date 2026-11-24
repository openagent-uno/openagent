import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from openagent_core.contracts import RunEvent, RunEventPage
from openagent_server.runtime_service import NativeRuntimeService, PreparedRun


async def test_cli_observes_after_disconnect_without_interruption(monkeypatch, capsys):
    from openagent_cli import main

    run = {"run_id": "fixture-run", "session_id": "fixture-chat", "status": "running"}
    client = SimpleNamespace(
        send_message=AsyncMock(return_value={"type": "error", "connection_lost": True}),
        runtime_run=AsyncMock(return_value=run),
        disconnect=AsyncMock(),
        target_handle="fixture",
    )
    monkeypatch.setattr(main, "_open_gateway_for_rest", AsyncMock(return_value=(client, None)))
    result = await main._run_ask_cli(
        "Fixture turn", "fixture-chat", 1, None, None, None, None, True,
        request_id="fixture-run",
    )
    assert result == main.EXIT_UNAVAILABLE
    assert json.loads(capsys.readouterr().out)["status"] == "running"
    client.send_message.assert_awaited_once_with("Fixture turn", "fixture-chat", request_id="fixture-run")
    client.runtime_run.assert_awaited_once_with("fixture-run")


async def test_cli_timeout_cancels_only_the_exact_observed_run(monkeypatch, capsys):
    from openagent_cli import main

    async def wait_for_turn(*args, **kwargs):
        await asyncio.Event().wait()

    run = {"run_id": "fixture-run", "session_id": "fixture-chat", "status": "running"}
    client = SimpleNamespace(
        send_message=AsyncMock(side_effect=wait_for_turn),
        runtime_run=AsyncMock(side_effect=[run, {**run, "status": "cancelled"}]),
        disconnect=AsyncMock(),
        target_handle="fixture",
    )
    monkeypatch.setattr(main, "_open_gateway_for_rest", AsyncMock(return_value=(client, None)))
    result = await main._run_ask_cli(
        "Fixture turn", "fixture-chat", .01, None, None, None, None, True,
        request_id="fixture-run",
    )
    assert result == main.EXIT_UNAVAILABLE
    output = json.loads(capsys.readouterr().out)
    assert (output["request_id"], output["status"]) == ("fixture-run", "cancelled")
    assert [(entry.args, entry.kwargs) for entry in client.runtime_run.await_args_list] == [
        (("fixture-run",), {}), (("fixture-run",), {"cancel": True}),
    ]


async def test_idle_run_observer_backs_off_and_preserves_final_event():
    class Runtime:
        pages = 0
        finish = False
        terminal_observed = False

        async def events_page(self, ident, cursor, context, *, limit):
            assert limit == 128
            self.pages += 1
            if self.terminal_observed:
                event = RunEvent(1, ident, "run.stream", {"kind": "done", "text": "Exact final"})
                return RunEventPage((event,), 1, False)
            return RunEventPage((), cursor, False)

        async def get_run(self, ident, context):
            self.terminal_observed = self.finish
            return SimpleNamespace(terminal=self.finish, status="success", output="Fallback")

    runtime = Runtime()
    prepared = PreparedRun(SimpleNamespace(run_id="fixture-run"), None)

    async def collect():
        return [frame async for frame in NativeRuntimeService.observe_run(
            SimpleNamespace(runtime=runtime), prepared,
        )]

    operation = asyncio.create_task(collect())
    try:
        await asyncio.sleep(1.15)
        assert runtime.pages <= 10
        runtime.finish = True
        assert await asyncio.wait_for(operation, 2) == [{"kind": "done", "text": "Exact final"}]
    finally:
        if not operation.done():
            operation.cancel()
            await asyncio.gather(operation, return_exceptions=True)
