"""Opt-in synthetic project fixture for the real Desktop + Iroh + guest test."""

from contextlib import asynccontextmanager
import asyncio
import json
import os
import shlex
from pathlib import Path

import sqlalchemy as sa

from openagent_core.computer_tasks import ComputerAllocation
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_server.project_tasks import SESSION, requests, task_ref


class ProjectTaskFixture:
    members = ("project-alice", "project-bravo")

    def __init__(self, network):
        self.project = {
            "id": "manual", "title": "Operations manual", "tenant": network, "members": list(self.members),
            "revisions": [{
                "label": "Approved revision",
                "commit": os.environ["OPENAGENT_TEST_LIMA_COMMIT"], "base": os.environ["OPENAGENT_TEST_LIMA_BASE"],
                "surfaces": ["terminal.read", "terminal.input", "preview.read", "computer.suspend"],
                "preview": {"port": 18285, "path": "/"},
            }],
        }
        self.config = {
            "lima_home": os.environ["OPENAGENT_TEST_LIMA_HOME"], "projects": [self.project],
            "computer_pool": {"id": "acceptance", "machines": 2, "machines_per_owner": 1,
                              "running": 1, "running_per_owner": 1, "cpus": 1,
                              "memory_bytes": 1024**3, "disk_bytes": 8 * 1024**3},
        }

    def answer(self, payload, decode):
        messages = payload["messages"]
        start = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=0)
        text = str(messages[start].get("content", ""))
        actor = next((name for marker, name in (("alpha review", "alice"), ("bravo review", "bravo"))
                      if marker in text), None)
        if not actor or not payload.get("tools"):
            return None, json.dumps({"summary": "Review", "topics": ["review"]})
        replies = [decode(m["content"]) for m in messages[start:] if m["role"] == "tool"]
        if not replies:
            return ("tool_search_list_servers", {}), None
        shell = next((tool for reply in replies[1:] if isinstance(reply, dict)
                      for tool in reply.get("tools", ()) if tool["name"] == "shell_exec"), None)
        if shell is None:
            source = replies[0][len(replies) - 1]["source_ref"]
            return ("tool_search_list_tools", {"source_ref": source}), None
        if "tools" in replies[-1]:
            script = (
                'from pathlib import Path\nimport subprocess, sys\n'
                'd=Path("/srv/workspace")\n'
                f'(d/"review.txt").write_text("review for {actor}")\n'
                f'(d/"index.html").write_text("<h1>Preview for {actor}</h1>")\n'
                'subprocess.Popen([sys.executable,"-m","http.server","18285","--bind","127.0.0.1",'
                '"--directory",str(d)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,'
                'stderr=subprocess.DEVNULL,start_new_session=True)\nprint("review ready")'
            )
            return ("tool_search_call_tool", {"tool_ref": shell["tool_ref"],
                    "args": {"command": "python3 -c " + shlex.quote(script)}}), None
        if replies[-1].get("isError") or "review ready" not in str(replies[-1]):
            raise RuntimeError("Fixture shell did not confirm the edit")
        return None, "Completed review for " + actor

    @asynccontextmanager
    async def operator(self, service, root: Path):
        async def change_grant():
            command = root / "revoke-first"
            while not command.is_file():
                await asyncio.sleep(0.1)
            self.project["members"].remove(self.members[0])
            command.rename(root / "revoked-first")

        watcher = asyncio.create_task(change_grant())
        try:
            yield
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
            async with service.engine.connect() as db:
                rows = (await db.execute(sa.select(requests))).mappings().all()
            for row in rows:
                user = PrincipalRef(**json.loads(row["owner"]))
                ctx = ExecutionContext(user, user, user, SESSION + row["id"], row["agent"], (user,))
                await service.broker.provider.suspend(ComputerAllocation.for_context(ctx, task_ref(row)))
