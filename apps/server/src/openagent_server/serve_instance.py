"""Standalone process ownership; no discovery or termination of other processes."""
from contextlib import contextmanager
from pathlib import Path

from filelock import FileLock, Timeout


class ServerInstanceInUse(RuntimeError):
    """Another host process holds this installation's kernel lock."""


@contextmanager
def exclusive_server_instance(agent_dir: Path | None):
    """Hold a separate, nonblocking lock until the command context closes.

    The host chooses whether it has a durable installation directory. Core
    embedding and clientless configurations need no filesystem singleton.
    A marker alone is not ownership; the kernel releases ownership on process death.
    """
    if agent_dir is None:
        yield
        return
    directory = Path(agent_dir).resolve(strict=True)
    lock = FileLock(str(directory / '.openagent-serve.lock'), timeout=0, mode=0o600)
    try:
        lock.acquire()
    except Timeout:
        raise ServerInstanceInUse('This agent directory is already being served. Restart its existing service instead.') from None
    try:
        yield
    finally:
        lock.release()
