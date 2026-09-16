"""Exercise the installed CLI's real terminal, PAKE login and Iroh chat."""
from __future__ import annotations

import json
import os
from pathlib import Path
import pty
import queue
import re
import select
import subprocess
import sys
import tempfile
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def main():
    transcript = bytearray()
    server_logs = []
    with tempfile.TemporaryDirectory(prefix='openagent-installed-cli-') as temporary:
        root = Path(temporary)
        home = root / 'client-home'
        home.mkdir()
        environment = dict(os.environ, HOME=str(home), USERPROFILE=str(home), TERM='xterm-256color',
            XDG_CONFIG_HOME=str(home / '.config'), OPENAGENT_HOST_TOOLS_HOME=str(root / 'device'))
        environment.pop('PYTHONPATH', None)
        server = subprocess.Popen([sys.executable, '-u', str(ROOT / 'apps/server/scripts/desktop_real_iroh_harness.py'),
            '--root', str(root / 'server')], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, cwd=temporary, env=environment)
        ready = queue.Queue()

        def drain():
            for line in server.stdout:
                if line.startswith('OPENAGENT_DESKTOP_IROH_READY '):
                    ready.put(json.loads(line.split(' ', 1)[1]))
                else:
                    server_logs.append(line)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        client = None
        master = slave = None
        try:
            data = ready.get(timeout=40)
            master, slave = pty.openpty()
            client = subprocess.Popen([str(Path(sys.executable).with_name('openagent-cli')), 'connect', data['ticket'],
                '--handle', data['handle'], '--password', data['password'], '--agent', 'coordinator'],
                stdin=slave, stdout=slave, stderr=slave, env=environment, cwd=temporary, start_new_session=True)
            os.close(slave)
            slave = None

            def until(expected, seconds):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    text = ANSI.sub('', transcript.decode('utf8', 'replace'))
                    if expected in text:
                        return text
                    if client.poll() is not None:
                        raise AssertionError(f'CLI exited {client.returncode}: {text}')
                    readable, _, _ = select.select([master], [], [], .2)
                    if readable:
                        chunk = os.read(master, 65536)
                        transcript.extend(chunk)
                        if b'\x1b[6n' in chunk:
                            os.write(master, b'\x1b[1;1R')
                raise AssertionError(f'CLI did not show {expected!r}: {text}')

            until('You ›', 40)
            os.write(master, b'cli: fixture\r')
            until('CLI fixture complete', 45)
            os.write(master, b'/exit\r')
            client.wait(timeout=15)
            if client.returncode:
                raise AssertionError(f'CLI exited {client.returncode}')
            evidence = json.loads(Path(data['evidence_path']).read_text())
            agent_calls = [call for call in evidence if call.get('tools')]
            if len(agent_calls) != 2:
                raise AssertionError(f'Expected discovery and one final model reply, got {len(agent_calls)}')
            if not (home / '.openagent/user/networks.toml').is_file():
                raise AssertionError('CLI did not persist its temporary network membership')
            receipt = {'qualification':'local-authenticated-terminal','provider':'deterministic-local-http',
                'transport':'PAKE certificate + Iroh','model_calls':len(agent_calls),
                'unrelated_app_capabilities':False,'exit_code':client.returncode}
            output = ROOT / 'artifacts/installed-cli-verification.json'
            output.parent.mkdir(exist_ok=True)
            output.write_text(json.dumps(receipt, indent=2) + '\n')
            print(json.dumps(receipt, sort_keys=True))
        except BaseException:
            print(ANSI.sub('', transcript.decode('utf8', 'replace')), file=sys.stderr)
            print(''.join(server_logs)[-12000:], file=sys.stderr)
            raise
        finally:
            if client is not None and client.poll() is None:
                client.terminate()
                try:
                    client.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    client.kill()
                    client.wait()
            for descriptor in (master, slave):
                if descriptor is not None:
                    os.close(descriptor)
            if server.poll() is None:
                server.stdin.write('stop\n')
                server.stdin.flush()
                try:
                    server.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    server.terminate()
                    server.wait(timeout=10)
            reader.join(timeout=2)


if __name__ == '__main__':
    main()
