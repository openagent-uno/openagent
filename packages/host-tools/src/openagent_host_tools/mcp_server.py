"""Legacy import/dispatcher; individual commands are owned by tool packages."""
import asyncio
import sys
from pathlib import Path
from openagent_tool_protocol.mcp import SHELL_COMPLETION_LOGGER, SHELL_COMPLETION_CAPABILITY, SHELL_COMPLETION_CAPABILITY_VERSION, _tool_wire
from openagent_tool_protocol.mcp import serve as serve_capability
from openagent_filesystem import FilesystemServer, main as filesystem_main
from openagent_editor import EditorServer, main as editor_main
from openagent_shell import ShellServer, main as shell_main

def _server(name, *, shell_event_sink=None):
    return {"filesystem": FilesystemServer, "editor": EditorServer, "shell": lambda cwd: ShellServer(cwd, event_sink=shell_event_sink)}[name](Path.cwd())

async def serve(name):
    await serve_capability(lambda sink: _server(name, shell_event_sink=sink), completion_events=name == "shell")

def main(name=None):
    asyncio.run(serve(name or sys.argv[1]))

if __name__ == "__main__":
    main()
