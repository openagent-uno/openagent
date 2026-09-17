import importlib.util
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "scripts/workspace.py"
SPEC = importlib.util.spec_from_file_location("workspace", MODULE)
workspace = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace)


class WorkspaceTests(unittest.TestCase):
    def test_artifacts_keep_exact_component_ownership(self):
        components = workspace.configuration()["components"]
        for filename, expected in [("openagent-cli-1.0.0-linux-arm64.tar.gz", "cli"),
                                   ("openagent-app-1.0.0-macos-arm64.dmg", "app"),
                                   ("openagent_host_tools-1.0.0-py3-none-any.whl", "host-tools"),
                                   ("openagent-1.0.0-linux-arm64.tar.gz", "server")]:
            self.assertEqual(workspace.artifact_owner(filename, components), expected)
        with self.assertRaises(ValueError):
            workspace.artifact_owner("unattributed.tar.gz", components)

    def test_manifest_rejects_symlink_even_inside_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "openagent-1.tar.gz").write_bytes(b"package")
            (root / "openagent-2.tar.gz").symlink_to(root / "openagent-1.tar.gz")
            with self.assertRaisesRegex(ValueError, "symlink"):
                workspace.release_manifest(root)

    def test_manifest_has_digest_without_claiming_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "openagent-1.tar.gz").write_bytes(b"package")
            (root / "manifest.json").write_text('{"format":1}\n')
            (root / ".gitignore").write_text("*\n")
            receipt = workspace.release_manifest(root)
            self.assertEqual(receipt["qualification"], "development-unqualified")
            self.assertEqual(receipt["artifacts"][0]["size"], 7)
            self.assertEqual(len(receipt["artifacts"][0]["sha256"]), 64)
            self.assertEqual(receipt["build_manifests"][0]["path"], "manifest.json")
            self.assertEqual(len(receipt["build_manifests"][0]["sha256"]), 64)
            self.assertFalse(receipt["compatibility"]["updater_transition_qualified"])


if __name__ == "__main__":
    unittest.main()
