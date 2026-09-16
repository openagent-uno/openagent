import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class AudioWorkerEntryTests(unittest.TestCase):
    def test_private_worker_entry_does_not_bootstrap_server(self):
        with tempfile.TemporaryDirectory(prefix='openagent-audio-entry-') as directory:
            result = subprocess.run([sys.executable, '-m', 'openagent_server.cli', '_audio-worker'],
                input='{}', text=True, capture_output=True, cwd=directory,
                env={**os.environ, 'HOME':directory}, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'error':'audio_provider_unavailable'})
            self.assertEqual(result.stderr, '')
            self.assertEqual(list(Path(directory).iterdir()), [])
