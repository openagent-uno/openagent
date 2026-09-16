"""Live terminal attachment: input and observation never own a server turn."""

from __future__ import annotations

import asyncio
import sys
import uuid
from urllib.parse import quote

from prompt_toolkit import PromptSession
from prompt_toolkit.patch_stdout import patch_stdout


class SharedRepl:
    def __init__(self, client, console):
        self.client, self.console = client, console
        self.shared = client.collaboration()
        self.session_id = None
        self.observer = None
        self.tasks = set()
        self.states = {}
        self.printed = {}
        self.prompt = PromptSession()
        self.people = []

    async def read(self):
        with patch_stdout(raw=True):
            return await self.prompt.prompt_async("You › ", bottom_toolbar=self.toolbar)

    def toolbar(self):
        people = ", ".join(p.get("name", "") for p in self.people)
        busy = any(t.get("active") for t in self.states.get("turns", []))
        return ("Generating · send to steer · /stop" if busy else "Connected") + (
            " · " + people if people else ""
        )

    async def switch(self, session_id):
        if self.session_id == session_id:
            return
        if self.observer:
            self.observer.cancel()
            await asyncio.gather(self.observer, return_exceptions=True)
        self.session_id = session_id
        self.states, self.printed, self.people = {}, {}, []
        self.observer = asyncio.create_task(self.observe(session_id))

    async def observe(self, session_id):
        try:
            path = (
                self.shared.base_url
                + "/api/collaboration/"
                + quote(session_id, safe="")
                + "/commands"
            )
            async with self.shared.session.get(path) as response:
                if response.status == 200:
                    self.render(await response.json())
            async for frame in self.shared.observe(
                [session_id], focus={"kind": "session", "id": session_id}
            ):
                if self.session_id != session_id:
                    return
                kind = frame.get("type")
                if kind in {"shared_reset", "shared_revoked"}:
                    self.states, self.people = {}, []
                    if kind == "shared_revoked":
                        self.printed.clear()
                        self.console.print("Session access revoked.", style="yellow")
                elif kind == "shared_presence":
                    self.people = frame.get("people", [])
                elif kind == "shared_state":
                    self.states = frame
                    self.render(frame)
                self.prompt.app.invalidate()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.states, self.people = {}, []
            self.console.print(str(exc), style="red", markup=False)

    def render(self, snapshot):
        for turn in snapshot.get("turns", []):
            for message in turn.get("messages", []):
                key = (turn["id"], message["id"])
                text = message.get("text", "")
                previous = self.printed.get(key)
                if previous == text:
                    continue
                if message["role"] == "user":
                    if previous is None:
                        author = message.get("author") or {}
                        self.console.print(
                            "\n"
                            + (author.get("display") or author.get("handle") or "User")
                            + ": "
                            + text,
                            markup=False,
                        )
                else:
                    if previous is None:
                        self.console.print("\nAgent: ", end="", markup=False)
                    delta = (
                        text[len(previous) :]
                        if previous is not None and text.startswith(previous)
                        else text
                    )
                    sys.stdout.write(delta)
                    sys.stdout.flush()
                self.printed[key] = text
            end_key = (turn["id"], "finished")
            if not turn.get("active") and end_key not in self.printed:
                self.console.print()
                self.printed[end_key] = "1"
        retained = {t["id"] for t in snapshot.get("turns", [])}
        self.printed = {k: v for k, v in self.printed.items() if k[0] in retained}

    def submit(self, text, session_id, attachments=None):
        request_id = uuid.uuid4().hex

        async def run():
            await self.shared.ensure_session(session_id, text)
            result = await self.shared.send_turn(
                session_id,
                request_id,
                text,
                delivery="queue" if text.startswith("/") else "steer",
                client_instance_id=self.client.client_instance_id,
                attachments=attachments,
            )
            if result.get("errored"):
                self.console.print(
                    result.get("response", "Command failed"), style="red", markup=False
                )

        task = asyncio.create_task(run())
        self.tasks.add(task)

        def done(completed):
            self.tasks.discard(completed)
            if not completed.cancelled() and completed.exception():
                self.console.print(
                    str(completed.exception()), style="red", markup=False
                )

        task.add_done_callback(done)

    async def stop(self, session_id):
        turn = next(
            (t for t in reversed(self.states.get("turns", [])) if t.get("active")), None
        )
        if turn and turn.get("runId"):
            await self.shared.stop_turn(session_id, turn["runId"])

    async def close(self):
        if self.observer:
            self.observer.cancel()
        pending = list(self.tasks)
        for task in pending:
            task.cancel()  # cancels only the HTTP attachment; server execution continues
        await asyncio.gather(
            *pending,
            *([self.observer] if self.observer else []),
            return_exceptions=True,
        )
        self.observer = None
