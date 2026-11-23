from pathlib import Path
import json
import sqlite3
import tempfile
import unittest

from openagent_server.state_inventory import inspect_state


class StateInventory(unittest.TestCase):
    def test_finds_auxiliary_databases_and_links_without_following_or_disclosing_them(
        self,
    ):
        with tempfile.TemporaryDirectory() as staging:
            base = Path(staging)
            root = base / "source"
            root.mkdir()
            db = root / "opaque-archive"
            with sqlite3.connect(db) as con:
                con.execute("CREATE TABLE fixture(v)")
            (root / "secret-name").symlink_to("opaque-archive")
            (root / "outside").symlink_to("../missing")
            private = base / "operator-map"
            report = inspect_state(root, destination=base, private_manifest=private)
            self.assertEqual(report["counts"]["sqlite_databases"], 1)
            self.assertEqual(report["counts"]["external_link"], 1)
            self.assertEqual(report["counts"]["internal_link"], 1)
            self.assertEqual(report["counts"]["dangling_links"], 1)
            self.assertNotIn("secret-name", json.dumps(report))
            self.assertEqual(private.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(json.loads(private.read_text())), 3)
            with self.assertRaises(FileExistsError):
                inspect_state(root, destination=base, private_manifest=private)
