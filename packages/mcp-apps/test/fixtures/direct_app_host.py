"""Owned direct facade fixture: no broker daemon and no native/browser builtins."""
import asyncio
import os
from pathlib import Path
import signal
import sys
from openagent_host_tools.host import CapabilityHost
from openagent_host_tools.paths import HostPaths
from openagent_host_tools.stdio import StdioBroker


async def main():
    if len(sys.argv)!=2:raise ValueError('An explicitly owned fixture home is required')
    home=Path(sys.argv[1]).resolve()
    if not (home/'owned-mcp-app-fixture').is_file():raise ValueError('Fixture ownership marker missing')
    host=CapabilityHost(paths=HostPaths(home),builtin_names=())
    task=asyncio.create_task(StdioBroker(host).run())
    stopping=False
    def stop():
        nonlocal stopping
        stopping=True
        task.cancel()
    loop=asyncio.get_running_loop()
    for sig in (signal.SIGTERM,signal.SIGINT):loop.add_signal_handler(sig,stop)
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        # The facade retains and awaits every owned MCP child. Do this before
        # exiting the stdin executor, which may otherwise block on a pipe that
        # the peer has not yet closed. No PID discovery or user broker cleanup.
        await host.close()
    if stopping:os._exit(0)

asyncio.run(main())
