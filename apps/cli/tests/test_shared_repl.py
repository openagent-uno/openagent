import asyncio
import io
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from rich.console import Console
from openagent_cli.shared_repl import SharedRepl


class SharedReplTests(unittest.IsolatedAsyncioTestCase):
    def make_repl(self):
        shared = SimpleNamespace(
            ensure_session=AsyncMock(), send_turn=AsyncMock(), stop_turn=AsyncMock()
        )
        client = SimpleNamespace(
            collaboration=lambda: shared, client_instance_id="terminal-1"
        )
        output = io.StringIO()
        with patch("openagent_cli.shared_repl.PromptSession", return_value=Mock()):
            repl = SharedRepl(client, Console(file=output, force_terminal=False))
        self.addAsyncCleanup(repl.close)
        return repl, shared, output

    async def test_input_remains_available_during_two_steering_submissions(self):
        repl, shared, _ = self.make_repl()
        release = asyncio.Event()
        started = asyncio.Queue()

        async def run(*args, **kwargs):
            started.put_nowait((args, kwargs))
            await release.wait()
            return {"response": "done"}

        shared.send_turn.side_effect = run
        repl.submit("Alice", "chat")
        first = await asyncio.wait_for(started.get(), 1)
        repl.submit("Bob steers", "chat")
        second = await asyncio.wait_for(started.get(), 1)
        self.assertEqual(len(repl.tasks), 2)
        self.assertEqual(second[1]["delivery"], "steer")
        self.assertEqual(second[1]["client_instance_id"], "terminal-1")
        self.assertNotEqual(first[0][1], second[0][1])
        release.set()
        await asyncio.gather(*repl.tasks)

    async def test_commands_queue_and_stop_targets_snapshot_request(self):
        repl, shared, _ = self.make_repl()
        shared.send_turn.return_value = {"response": "done"}
        repl.submit("/model auto", "chat")
        await asyncio.gather(*repl.tasks)
        self.assertEqual(shared.send_turn.call_args.kwargs["delivery"], "queue")
        repl.states = {
            "turns": [
                {"runId": "old", "active": False},
                {"runId": "bob", "active": True},
            ]
        }
        await repl.stop("chat")
        shared.stop_turn.assert_awaited_once_with("chat", "bob")

    async def test_switch_and_close_detach_without_stopping_execution(self):
        repl, shared, _ = self.make_repl()
        entered = asyncio.Queue()

        async def observe(sid):
            entered.put_nowait(sid)
            await asyncio.Event().wait()

        repl.observe = observe
        await repl.switch("one")
        self.assertEqual(await entered.get(), "one")
        first = repl.observer
        await repl.switch("two")
        self.assertEqual(await entered.get(), "two")
        self.assertTrue(first.cancelled())
        await repl.close()
        shared.stop_turn.assert_not_awaited()

    async def test_replayed_inputs_keep_authors_without_duplicate_prints(self):
        repl, _, output = self.make_repl()
        snapshot = {
            "turns": [
                {
                    "id": user,
                    "active": True,
                    "messages": [
                        {
                            "id": "input",
                            "role": "user",
                            "text": "same",
                            "author": {"handle": user},
                        }
                    ],
                }
                for user in ["alice", "bob"]
            ]
        }
        repl.render(snapshot)
        repl.render(snapshot)
        self.assertEqual(output.getvalue().count("alice: same"), 1)
        self.assertEqual(output.getvalue().count("bob: same"), 1)

    async def test_observer_encodes_session_and_close_is_idempotent(self):
        repl, shared, _ = self.make_repl()
        requested = []

        class Response:
            status = 200

            async def json(self):
                return {"turns": []}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        observing = asyncio.Event()

        async def observe(sessions, focus=None):
            observing.set()
            await asyncio.Event().wait()
            yield {}

        shared.base_url = "http://agent"
        shared.session = SimpleNamespace(
            get=lambda url, **kw: requested.append(url) or Response()
        )
        shared.observe = observe
        await repl.switch("cli/one two")
        await asyncio.wait_for(observing.wait(), 1)
        # A session id is a path segment, never raw URL syntax.
        self.assertEqual(
            requested, ["http://agent/api/collaboration/cli%2Fone%20two/commands"]
        )
        observer = repl.observer
        await repl.close()
        self.assertTrue(observer.cancelled())
        self.assertIsNone(repl.observer)
        await repl.close()  # the error path may close an already-closed REPL
        shared.stop_turn.assert_not_awaited()
