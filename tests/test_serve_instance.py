"""Cross-process host lifetime ownership, independent of process arguments."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from openagent_server.serve_instance import exclusive_server_instance

HOLDER = '''
from pathlib import Path
import sys,time
from openagent_server.serve_instance import exclusive_server_instance,ServerInstanceInUse
try:
 with exclusive_server_instance(Path(sys.argv[1])):
  print('ready',flush=True)
  time.sleep(30)
except ServerInstanceInUse:
 print('busy',flush=True)
 raise SystemExit(3)
'''


class ServeInstance(unittest.TestCase):
    def holder(self, directory):
        child = subprocess.Popen([sys.executable, '-u', '-c', HOLDER, str(directory)],
            stdout=subprocess.PIPE, text=True)
        self.addCleanup(self.retire, child)
        return child

    def retire(self, child):
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)
        if not child.stdout.closed:
            child.stdout.close()

    def test_competing_start_is_rejected_without_terminating_current_host(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.holder(directory)
            self.assertEqual(first.stdout.readline().strip(), 'ready')
            second = self.holder(directory)
            self.assertEqual(second.stdout.readline().strip(), 'busy')
            self.assertEqual(second.wait(timeout=5), 3)
            self.assertIsNone(first.poll())
            self.retire(first)

    def test_kernel_releases_ownership_after_ungraceful_owner_death(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.holder(directory)
            self.assertEqual(first.stdout.readline().strip(), 'ready')
            first.kill();first.wait(timeout=5)
            self.assertTrue((Path(directory)/'.openagent-serve.lock').exists())
            second = self.holder(directory)
            self.assertEqual(second.stdout.readline().strip(), 'ready')
            self.retire(second)

    def test_independent_directories_can_run_concurrently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            one, two = root/'one', root/'two'
            one.mkdir();two.mkdir()
            first, second = self.holder(one), self.holder(two)
            self.assertEqual(first.stdout.readline().strip(), 'ready')
            self.assertEqual(second.stdout.readline().strip(), 'ready')
            self.assertIsNone(first.poll());self.assertIsNone(second.poll())
            self.retire(first);self.retire(second)

    def test_context_release_allows_next_owner_and_none_needs_no_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            with exclusive_server_instance(Path(directory)):
                pass
            with exclusive_server_instance(Path(directory)):
                pass
        with exclusive_server_instance(None):
            pass
