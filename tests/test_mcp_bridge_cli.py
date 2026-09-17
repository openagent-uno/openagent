import unittest
from unittest.mock import patch

from openagent_mcp.__main__ import main


class McpBridgeCliTests(unittest.TestCase):
    def test_help_and_version_do_not_require_runtime_configuration(self):
        for arguments in (["--help"], ["--version"]):
            with self.subTest(arguments=arguments), patch.dict(
                "os.environ", {}, clear=True,
            ), self.assertRaises(SystemExit) as stopped:
                main(arguments)
            self.assertEqual(stopped.exception.code, 0)

    def test_server_start_still_requires_an_explicit_config(self):
        with patch.dict("os.environ", {}, clear=True), self.assertRaises(SystemExit) as stopped:
            main([])
        self.assertEqual(stopped.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
