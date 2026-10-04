#!/usr/bin/env python3
"""Record a verified, externally supervised Chrome CDP endpoint for Agent in Chrome.

Run as the browser service user in ExecStartPost after starting Chrome with an
explicit profile and loopback debugging port. Linux /proc ownership and exact
launch flags must match before writing the sidecar's profile marker.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time
from urllib.parse import urlparse
from urllib.request import urlopen


def _owned_browser_running(profile: Path, port: int) -> bool:
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            argv = (process / "cmdline").read_bytes().split(b"\0")
            decoded = [arg.decode(errors="replace") for arg in argv if arg]
            if (
                any("chrome" in arg.lower() for arg in decoded[:1])
                and f"--user-data-dir={profile}" in decoded
                and f"--remote-debugging-port={port}" in decoded
            ):
                return True
        except (OSError, PermissionError):
            continue
    return False


def record(profile: Path, port: int, *, timeout: float = 20.0) -> Path:
    profile = profile.expanduser().resolve()
    if not 1024 <= port <= 65535:
        raise ValueError("port must be between 1024 and 65535")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _owned_browser_running(profile, port):
            time.sleep(0.25)
            continue
        try:
            with urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
                endpoint = json.load(response)["webSocketDebuggerUrl"]
            parsed = urlparse(endpoint)
            if (
                parsed.scheme != "ws"
                or parsed.hostname not in {"127.0.0.1", "localhost"}
                or parsed.port != port
                or not parsed.path.startswith("/devtools/browser/")
            ):
                raise ValueError("unexpected Chrome CDP endpoint")
            marker = profile / "DevToolsActivePort"
            staging = marker.with_name("DevToolsActivePort.tmp")
            staging.write_text(f"{port}\n{parsed.path}\n", encoding="utf-8")
            staging.chmod(0o600)
            os.replace(staging, marker)
            return marker
        except (OSError, KeyError, ValueError):
            time.sleep(0.25)
    raise TimeoutError("owned Chrome profile and loopback CDP endpoint did not become ready")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    arguments = parser.parse_args()
    print(record(arguments.profile, arguments.port))
