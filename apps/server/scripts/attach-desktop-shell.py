#!/usr/bin/env python3
"""Attach window decorations and a taskbar to an explicitly supervised X11 browser.

Run as the browser's OS user, in its mount namespace (systemd JoinsNamespaceOf
when PrivateTmp is enabled). Never creates/replaces a display or browser profile.
The operator must install openbox, tint2 and xsetroot first.
"""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import signal
import subprocess
import time


def browser_environment(service: str) -> dict[str, str]:
    pid = int(subprocess.check_output(['systemctl', 'show', '--value', '-p', 'MainPID', service], text=True).strip())
    pending, seen = [pid], set()
    while pending:
        pid = pending.pop()
        if pid <= 1 or pid in seen:
            continue
        seen.add(pid)
        root = Path('/proc') / str(pid)
        try:
            if root.stat().st_uid != os.getuid():
                continue
            pending.extend(int(p) for p in (root / 'task' / str(pid) / 'children').read_text().split())
            env = dict(value.split('=', 1) for value in (root / 'environ').read_bytes().decode().split('\0') if '=' in value)
            args = (root / 'cmdline').read_bytes().split(b'\0')
            if env.get('DISPLAY') and any(a.startswith(b'--remote-debugging-port=') for a in args):
                # Inherit graphical routing only; no service credentials enter
                # the desktop shell or its children.
                return {key: env[key] for key in ('DISPLAY', 'XAUTHORITY') if key in env}
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    raise RuntimeError('The exact supervised browser has no X11 display yet')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser-service', required=True)
    args = parser.parse_args()
    graphical = None
    for _ in range(120):
        try:
            graphical = browser_environment(args.browser_service)
            break
        except (RuntimeError, ValueError, subprocess.CalledProcessError):
            time.sleep(.25)
    if graphical is None:
        raise SystemExit('Supervised X11 browser unavailable; no alternate display selected')
    env = {**os.environ, **graphical}
    # Refuse to replace somebody else's window manager.
    probe = subprocess.check_output(['xprop', '-root', '_NET_SUPPORTING_WM_CHECK'], env=env, text=True)
    if 'window id #' in probe and not probe.rstrip().endswith('0x0'):
        raise SystemExit('This display already has a window manager')
    children = []
    def stop(*_):
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        subprocess.run(['xsetroot', '-solid', '#171b24'], env=env, check=True)
        children.append(subprocess.Popen(['openbox', '--sm-disable'], env=env))
        for _ in range(40):
            if children[0].poll() is not None:
                raise RuntimeError('Window manager failed')
            probe = subprocess.check_output(['xprop', '-root', '_NET_SUPPORTING_WM_CHECK'], env=env, text=True)
            if 'window id #' in probe and not probe.rstrip().endswith('0x0'):
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Window manager did not become ready')
        children.append(subprocess.Popen(['tint2'], env=env))
        while all(child.poll() is None for child in children):
            time.sleep(.25)
    finally:
        stop()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    main()
