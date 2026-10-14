"""Finite hosted source guards; these fixtures are not visual acceptance."""
import hashlib
import io
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qualify_public_marketplace_visual as qualifier


class Response(io.BytesIO):
    status = 200


class Contracts(unittest.TestCase):
    def test_wrong_digest_rejects_bytes_before_installer_or_app_execution(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(qualifier.urllib.request, 'urlopen', return_value=Response(b'changed')):
            with self.assertRaises(ValueError):
                qualifier.acquire('https://example.invalid/fixture', Path(tmp) / 'bytes', '0' * 64, 100)

    def test_download_budget_and_exact_size_are_both_required(self):
        digest = hashlib.sha256(b'neutral').hexdigest()
        for budget, size in ((3, 7), (10, 8)):
            with self.subTest(budget=budget, size=size), tempfile.TemporaryDirectory() as tmp, \
                 patch.object(qualifier.urllib.request, 'urlopen', return_value=Response(b'neutral')):
                with self.assertRaises(ValueError):
                    qualifier.acquire('https://example.invalid/fixture', Path(tmp) / 'bytes', digest, budget, size)

    def test_cleanup_targets_only_the_owned_server_group_and_fails_if_still_alive(self):
        child = Mock(pid=12345)
        child.poll.return_value = None
        child.wait.side_effect = qualifier.subprocess.TimeoutExpired(['synthetic'], 1)
        with patch.object(qualifier.os, 'killpg') as kill:
            with self.assertRaises(qualifier.subprocess.TimeoutExpired):
                qualifier.stop_owned_server(child)
            self.assertEqual(kill.call_args_list[0].args, (12345, signal.SIGTERM))
            self.assertEqual(kill.call_args_list[1].args, (12345, signal.SIGKILL))


if __name__ == '__main__':
    unittest.main()
